import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { ModelId } from './vla-ecs-stack.js';

export interface VlaBuildStackProps extends cdk.StackProps {
  modelId: ModelId;
  version: string;
}

interface ModelBuildConfig {
  ecrRepoName: string;
  codeBuildProjectName: string;
  // version-specific override: if provided, overrides dockerContextDir per version
  dockerContextDirByVersion?: Record<string, string>;
  dockerContextDir: string;
  imageName: string;
  hfTokenSecretName?: string;
  computeType?: codebuild.ComputeType;
}

const MODEL_BUILD_CONFIGS: Record<ModelId, ModelBuildConfig> = {
  gr00t: {
    ecrRepoName: 'gr00t-realtime',
    codeBuildProjectName: 'gr00t-realtime-build',
    dockerContextDir: '../docker/gr00t-n17',  // default (latest)
    dockerContextDirByVersion: {
      'N1.6': '../docker/gr00t-n16',
      'N1.7': '../docker/gr00t-n17',
    },
    imageName: 'gr00t-realtime',
    // model weights on EFS — no HF token needed at build time
    computeType: codebuild.ComputeType.LARGE,
  },
  pi: {
    ecrRepoName: 'vla-pi-realtime',
    codeBuildProjectName: 'vla-pi-realtime-build',
    dockerContextDir: '../docker/pi',
    imageName: 'vla-pi-realtime',
  },
  openvla: {
    ecrRepoName: 'vla-openvla-realtime',
    codeBuildProjectName: 'vla-openvla-realtime-build',
    dockerContextDir: '../docker/openvla',
    imageName: 'vla-openvla-realtime',
    // openvla-7b bake-in at build time (~14 GB BF16); LARGE compute for fast layer push
    computeType: codebuild.ComputeType.LARGE,
  },
  smolvla: {
    ecrRepoName: 'vla-smolvla-realtime',
    codeBuildProjectName: 'vla-smolvla-realtime-build',
    dockerContextDir: '../docker/smolvla',
    imageName: 'vla-smolvla-realtime',
    // SmolVLA 450M bake-in (~1 GB) — MEDIUM 충분
  },
};

export class VlaBuildStack extends cdk.Stack {
  public readonly ecrRepo: ecr.Repository;
  public readonly ecrRepoUri: string;

  constructor(scope: Construct, id: string, props: VlaBuildStackProps) {
    super(scope, id, props);

    const { modelId, version } = props;
    const region  = this.region;
    const account = this.account;
    const config  = MODEL_BUILD_CONFIGS[modelId];
    // Image tag includes version: e.g. "N1.6-latest", "0.5-latest"
    const imageTag = `${version}-latest`;
    // Resolve docker context dir: version-specific override takes precedence
    const dockerContextDir = config.dockerContextDirByVersion?.[version] ?? config.dockerContextDir;

    // ── HF Token Secret (gr00t only) ─────────────────────────────────────────
    // HuggingFace token — model pre-bake at build time (BuildKit secret mount).
    // Store plain-text HF token (hf_xxx...) at this secret name.
    // Override via CDK context: -c hfTokenSecretName=<name>
    const hfTokenSecretName = config.hfTokenSecretName
      ? (this.node.tryGetContext('hfTokenSecretName') as string ?? config.hfTokenSecretName)
      : undefined;
    const hfTokenSecret = hfTokenSecretName
      ? sm.Secret.fromSecretNameV2(this, 'HfTokenSecret', hfTokenSecretName)
      : undefined;

    // ── Docker source: S3 Asset ───────────────────────────────────────────────
    // CDK zips the docker/<model>/ directory at deploy time and uploads to the CDK
    // bootstrap S3 bucket. CodeBuild downloads and unzips it automatically.
    // When docker/<model>/ changes, re-run `cdk deploy <Model>BuildStack` to re-sync.
    const dockerSource = new s3assets.Asset(this, 'DockerSource', {
      path: path.join(__dirname, dockerContextDir),
    });

    // ── ECR Repository ───────────────────────────────────────────────────────
    this.ecrRepo = new ecr.Repository(this, 'EcrRepo', {
      repositoryName: config.ecrRepoName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // ── IAM Role ─────────────────────────────────────────────────────────────
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    this.ecrRepo.grantPullPush(buildRole);
    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    if (hfTokenSecret) hfTokenSecret.grantRead(buildRole);
    dockerSource.grantRead(buildRole);

    // ── BuildSpec ─────────────────────────────────────────────────────────────
    const buildCommands = hfTokenSecretName
      ? [
          // DOCKER_BUILDKIT=1: required for --secret mount.
          // --secret id=hf_token,env=HF_TOKEN: passes SM secret as BuildKit secret
          //   (not stored in image layer history).
          `DOCKER_BUILDKIT=1 docker build --secret id=hf_token,env=HF_TOKEN -t ${config.imageName}:${imageTag} .`,
          `docker tag ${config.imageName}:${imageTag} ${account}.dkr.ecr.${region}.amazonaws.com/${config.ecrRepoName}:${imageTag}`,
        ]
      : [
          // DOCKER_BUILDKIT=1 is kept to support dockerfile:1 syntax directive in Dockerfile.
          // No --secret flag needed: pi0.5 checkpoint is on GCS public bucket.
          `DOCKER_BUILDKIT=1 docker build -t ${config.imageName}:${imageTag} .`,
          `docker tag ${config.imageName}:${imageTag} ${account}.dkr.ecr.${region}.amazonaws.com/${config.ecrRepoName}:${imageTag}`,
        ];

    const envSection = hfTokenSecretName
      ? {
          'secrets-manager': {
            HF_TOKEN: hfTokenSecretName,
          },
        }
      : undefined;

    // ── CodeBuild Project ─────────────────────────────────────────────────────
    // Source: S3 Asset (docker/<model>/ directory zipped at cdk deploy time).
    // CodeBuild unzips the asset into $CODEBUILD_SRC_DIR automatically.
    // $CODEBUILD_SRC_DIR contents = docker/<model>/ directory (Dockerfile, serve.py, etc.)
    new codebuild.Project(this, 'BuildProject', {
      projectName: config.codeBuildProjectName,
      role: buildRole,
      source: codebuild.Source.s3({
        bucket: dockerSource.bucket,
        path: dockerSource.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: config.computeType ?? codebuild.ComputeType.MEDIUM,
        privileged: true,  // required for docker build
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        ...(envSection ? { env: envSection } : {}),
        phases: {
          pre_build: {
            commands: [
              `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com`,
            ],
          },
          build: {
            commands: buildCommands,
          },
          post_build: {
            commands: [
              `docker push ${account}.dkr.ecr.${region}.amazonaws.com/${config.ecrRepoName}:${imageTag}`,
            ],
          },
        },
      }),
    });

    this.ecrRepoUri = `${this.ecrRepo.repositoryUri}:${imageTag}`;

    new cdk.CfnOutput(this, 'EcrRepoUri',       { value: `${this.ecrRepo.repositoryUri}:${imageTag}` });
    new cdk.CfnOutput(this, 'ImageTag',          { value: imageTag });
    new cdk.CfnOutput(this, 'CodeBuildProject', { value: config.codeBuildProjectName });

    // ── cdk-nag Suppressions ─────────────────────────────────────────────────

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-CB4', reason: 'Sample project: CodeBuild uses built-in AES-256 encryption. KMS CMK adds cost and management overhead not warranted for a sample deployment.' },
    ]);

    NagSuppressions.addResourceSuppressions(buildRole, [
      { id: 'AwsSolutions-IAM5', reason: 'buildRole wildcards: (1) CDK-generated S3 asset bucket permissions (GetBucket*, GetObject*, List*) for the CDK bootstrap S3 asset, (2) CDK-generated CodeBuild log/report group wildcards for project execution, (3) ecr:GetAuthorizationToken on resource * per ECR API specification (required for docker login to ECR registry; ECR push/pull to the specific repo is scoped via grantPullPush).' },
    ], true);
  }
}
