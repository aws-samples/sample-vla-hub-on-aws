"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VlaBuildStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const sm = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const s3assets = __importStar(require("aws-cdk-lib/aws-s3-assets"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
const MODEL_BUILD_CONFIGS = {
    gr00t: {
        ecrRepoName: 'gr00t-realtime',
        codeBuildProjectName: 'gr00t-realtime-build',
        dockerContextDir: '../docker/gr00t-n17', // default (latest)
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
    lap: {
        ecrRepoName: 'vla-lap-realtime',
        codeBuildProjectName: 'vla-lap-realtime-build',
        dockerContextDir: '../docker/lap',
        imageName: 'vla-lap-realtime',
        // LAP-3B 체크포인트 bake-in (~12.4 GB) — public HF repo, 토큰 불필요.
        // openvla(~14 GB)와 동일하게 LARGE compute로 레이어 push 가속.
        computeType: codebuild.ComputeType.LARGE,
    },
};
class VlaBuildStack extends cdk.Stack {
    ecrRepo;
    ecrRepoUri;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { modelId, version } = props;
        const region = this.region;
        const account = this.account;
        const config = MODEL_BUILD_CONFIGS[modelId];
        // Image tag includes version: e.g. "N1.6-latest", "0.5-latest"
        const imageTag = `${version}-latest`;
        // Resolve docker context dir: version-specific override takes precedence
        const dockerContextDir = config.dockerContextDirByVersion?.[version] ?? config.dockerContextDir;
        // ── HF Token Secret (gr00t only) ─────────────────────────────────────────
        // HuggingFace token — model pre-bake at build time (BuildKit secret mount).
        // Store plain-text HF token (hf_xxx...) at this secret name.
        // Override via CDK context: -c hfTokenSecretName=<name>
        const hfTokenSecretName = config.hfTokenSecretName
            ? (this.node.tryGetContext('hfTokenSecretName') ?? config.hfTokenSecretName)
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
        if (hfTokenSecret)
            hfTokenSecret.grantRead(buildRole);
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
                privileged: true, // required for docker build
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
        new cdk.CfnOutput(this, 'EcrRepoUri', { value: `${this.ecrRepo.repositoryUri}:${imageTag}` });
        new cdk.CfnOutput(this, 'ImageTag', { value: imageTag });
        new cdk.CfnOutput(this, 'CodeBuildProject', { value: config.codeBuildProjectName });
        // ── cdk-nag Suppressions ─────────────────────────────────────────────────
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-CB4', reason: 'Sample project: CodeBuild uses built-in AES-256 encryption. KMS CMK adds cost and management overhead not warranted for a sample deployment.' },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(buildRole, [
            { id: 'AwsSolutions-IAM5', reason: 'buildRole wildcards: (1) CDK-generated S3 asset bucket permissions (GetBucket*, GetObject*, List*) for the CDK bootstrap S3 asset, (2) CDK-generated CodeBuild log/report group wildcards for project execution, (3) ecr:GetAuthorizationToken on resource * per ECR API specification (required for docker login to ECR registry; ECR push/pull to the specific repo is scoped via grantPullPush).' },
        ], true);
    }
}
exports.VlaBuildStack = VlaBuildStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmxhLWJ1aWxkLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidmxhLWJ1aWxkLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHFFQUF1RDtBQUN2RCxtRUFBcUQ7QUFDckQsb0VBQXNEO0FBQ3RELDJDQUE2QjtBQUU3QixxQ0FBMEM7QUFtQjFDLE1BQU0sbUJBQW1CLEdBQXNDO0lBQzdELEtBQUssRUFBRTtRQUNMLFdBQVcsRUFBRSxnQkFBZ0I7UUFDN0Isb0JBQW9CLEVBQUUsc0JBQXNCO1FBQzVDLGdCQUFnQixFQUFFLHFCQUFxQixFQUFHLG1CQUFtQjtRQUM3RCx5QkFBeUIsRUFBRTtZQUN6QixNQUFNLEVBQUUscUJBQXFCO1lBQzdCLE1BQU0sRUFBRSxxQkFBcUI7U0FDOUI7UUFDRCxTQUFTLEVBQUUsZ0JBQWdCO1FBQzNCLDBEQUEwRDtRQUMxRCxXQUFXLEVBQUUsU0FBUyxDQUFDLFdBQVcsQ0FBQyxLQUFLO0tBQ3pDO0lBQ0QsRUFBRSxFQUFFO1FBQ0YsV0FBVyxFQUFFLGlCQUFpQjtRQUM5QixvQkFBb0IsRUFBRSx1QkFBdUI7UUFDN0MsZ0JBQWdCLEVBQUUsY0FBYztRQUNoQyxTQUFTLEVBQUUsaUJBQWlCO0tBQzdCO0lBQ0QsT0FBTyxFQUFFO1FBQ1AsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxvQkFBb0IsRUFBRSw0QkFBNEI7UUFDbEQsZ0JBQWdCLEVBQUUsbUJBQW1CO1FBQ3JDLFNBQVMsRUFBRSxzQkFBc0I7UUFDakMsb0ZBQW9GO1FBQ3BGLFdBQVcsRUFBRSxTQUFTLENBQUMsV0FBVyxDQUFDLEtBQUs7S0FDekM7SUFDRCxPQUFPLEVBQUU7UUFDUCxXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLG9CQUFvQixFQUFFLDRCQUE0QjtRQUNsRCxnQkFBZ0IsRUFBRSxtQkFBbUI7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O1FBQ2xFLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLG9CQUFvQixFQUFFLENBQUMsQ0FBQztRQUVwRiw0RUFBNEU7UUFFNUUseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekMsRUFBRSxFQUFFLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxFQUFFLDhJQUE4SSxFQUFFO1NBQ25MLENBQUMsQ0FBQztRQUVILHlCQUFlLENBQUMsdUJBQXVCLENBQUMsU0FBUyxFQUFFO1lBQ2pELEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxxWUFBcVksRUFBRTtTQUMzYSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1gsQ0FBQztDQUNGO0FBbklELHNDQW1JQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBjb2RlYnVpbGQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZGVidWlsZCc7XG5pbXBvcnQgKiBhcyBzbSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0ICogYXMgczNhc3NldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWFzc2V0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcbmltcG9ydCB7IE1vZGVsSWQgfSBmcm9tICcuL3ZsYS1lY3Mtc3RhY2suanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZsYUJ1aWxkU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbW9kZWxJZDogTW9kZWxJZDtcbiAgdmVyc2lvbjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgTW9kZWxCdWlsZENvbmZpZyB7XG4gIGVjclJlcG9OYW1lOiBzdHJpbmc7XG4gIGNvZGVCdWlsZFByb2plY3ROYW1lOiBzdHJpbmc7XG4gIC8vIHZlcnNpb24tc3BlY2lmaWMgb3ZlcnJpZGU6IGlmIHByb3ZpZGVkLCBvdmVycmlkZXMgZG9ja2VyQ29udGV4dERpciBwZXIgdmVyc2lvblxuICBkb2NrZXJDb250ZXh0RGlyQnlWZXJzaW9uPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgZG9ja2VyQ29udGV4dERpcjogc3RyaW5nO1xuICBpbWFnZU5hbWU6IHN0cmluZztcbiAgaGZUb2tlblNlY3JldE5hbWU/OiBzdHJpbmc7XG4gIGNvbXB1dGVUeXBlPzogY29kZWJ1aWxkLkNvbXB1dGVUeXBlO1xufVxuXG5jb25zdCBNT0RFTF9CVUlMRF9DT05GSUdTOiBSZWNvcmQ8TW9kZWxJZCwgTW9kZWxCdWlsZENvbmZpZz4gPSB7XG4gIGdyMDB0OiB7XG4gICAgZWNyUmVwb05hbWU6ICdncjAwdC1yZWFsdGltZScsXG4gICAgY29kZUJ1aWxkUHJvamVjdE5hbWU6ICdncjAwdC1yZWFsdGltZS1idWlsZCcsXG4gICAgZG9ja2VyQ29udGV4dERpcjogJy4uL2RvY2tlci9ncjAwdC1uMTcnLCAgLy8gZGVmYXVsdCAobGF0ZXN0KVxuICAgIGRvY2tlckNvbnRleHREaXJCeVZlcnNpb246IHtcbiAgICAgICdOMS42JzogJy4uL2RvY2tlci9ncjAwdC1uMTYnLFxuICAgICAgJ04xLjcnOiAnLi4vZG9ja2VyL2dyMDB0LW4xNycsXG4gICAgfSxcbiAgICBpbWFnZU5hbWU6ICdncjAwdC1yZWFsdGltZScsXG4gICAgLy8gbW9kZWwgd2VpZ2h0cyBvbiBFRlMg4oCUIG5vIEhGIHRva2VuIG5lZWRlZCBhdCBidWlsZCB0aW1lXG4gICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5MQVJHRSxcbiAgfSxcbiAgcGk6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1waS1yZWFsdGltZScsXG4gICAgY29kZUJ1aWxkUHJvamVjdE5hbWU6ICd2bGEtcGktcmVhbHRpbWUtYnVpbGQnLFxuICAgIGRvY2tlckNvbnRleHREaXI6ICcuLi9kb2NrZXIvcGknLFxuICAgIGltYWdlTmFtZTogJ3ZsYS1waS1yZWFsdGltZScsXG4gIH0sXG4gIG9wZW52bGE6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1vcGVudmxhLXJlYWx0aW1lJyxcbiAgICBjb2RlQnVpbGRQcm9qZWN0TmFtZTogJ3ZsYS1vcGVudmxhLXJlYWx0aW1lLWJ1aWxkJyxcbiAgICBkb2NrZXJDb250ZXh0RGlyOiAnLi4vZG9ja2VyL29wZW52bGEnLFxuICAgIGltYWdlTmFtZTogJ3ZsYS1vcGVudmxhLXJlYWx0aW1lJyxcbiAgICAvLyBvcGVudmxhLTdiIGJha2UtaW4gYXQgYnVpbGQgdGltZSAofjE0IEdCIEJGMTYpOyBMQVJHRSBjb21wdXRlIGZvciBmYXN0IGxheWVyIHB1c2hcbiAgICBjb21wdXRlVHlwZTogY29kZWJ1aWxkLkNvbXB1dGVUeXBlLkxBUkdFLFxuICB9LFxuICBzbW9sdmxhOiB7XG4gICAgZWNyUmVwb05hbWU6ICd2bGEtc21vbHZsYS1yZWFsdGltZScsXG4gICAgY29kZUJ1aWxkUHJvamVjdE5hbWU6ICd2bGEtc21vbHZsYS1yZWFsdGltZS1idWlsZCcsXG4gICAgZG9ja2VyQ29udGV4dERpcjogJy4uL2RvY2tlci9zbW9sdmxhJyxcbiAgICBpbWFnZU5hbWU6ICd2bGEtc21vbHZsYS1yZWFsdGltZScsXG4gICAgLy8gU21vbFZMQSA0NTBNIGJha2UtaW4gKH4xIEdCKSDigJQgTUVESVVNIOy2qeu2hFxuICB9LFxuICBsYXA6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1sYXAtcmVhbHRpbWUnLFxuICAgIGNvZGVCdWlsZFByb2plY3ROYW1lOiAndmxhLWxhcC1yZWFsdGltZS1idWlsZCcsXG4gICAgZG9ja2VyQ29udGV4dERpcjogJy4uL2RvY2tlci9sYXAnLFxuICAgIGltYWdlTmFtZTogJ3ZsYS1sYXAtcmVhbHRpbWUnLFxuICAgIC8vIExBUC0zQiDssrTtgaztj6zsnbjtirggYmFrZS1pbiAofjEyLjQgR0IpIOKAlCBwdWJsaWMgSEYgcmVwbywg7Yag7YGwIOu2iO2VhOyalC5cbiAgICAvLyBvcGVudmxhKH4xNCBHQinsmYAg64+Z7J287ZWY6rKMIExBUkdFIGNvbXB1dGXroZwg66CI7J207Ja0IHB1c2gg6rCA7IaNLlxuICAgIGNvbXB1dGVUeXBlOiBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuTEFSR0UsXG4gIH0sXG59O1xuXG5leHBvcnQgY2xhc3MgVmxhQnVpbGRTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBlY3JSZXBvOiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGVjclJlcG9Vcmk6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogVmxhQnVpbGRTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB7IG1vZGVsSWQsIHZlcnNpb24gfSA9IHByb3BzO1xuICAgIGNvbnN0IHJlZ2lvbiAgPSB0aGlzLnJlZ2lvbjtcbiAgICBjb25zdCBhY2NvdW50ID0gdGhpcy5hY2NvdW50O1xuICAgIGNvbnN0IGNvbmZpZyAgPSBNT0RFTF9CVUlMRF9DT05GSUdTW21vZGVsSWRdO1xuICAgIC8vIEltYWdlIHRhZyBpbmNsdWRlcyB2ZXJzaW9uOiBlLmcuIFwiTjEuNi1sYXRlc3RcIiwgXCIwLjUtbGF0ZXN0XCJcbiAgICBjb25zdCBpbWFnZVRhZyA9IGAke3ZlcnNpb259LWxhdGVzdGA7XG4gICAgLy8gUmVzb2x2ZSBkb2NrZXIgY29udGV4dCBkaXI6IHZlcnNpb24tc3BlY2lmaWMgb3ZlcnJpZGUgdGFrZXMgcHJlY2VkZW5jZVxuICAgIGNvbnN0IGRvY2tlckNvbnRleHREaXIgPSBjb25maWcuZG9ja2VyQ29udGV4dERpckJ5VmVyc2lvbj8uW3ZlcnNpb25dID8/IGNvbmZpZy5kb2NrZXJDb250ZXh0RGlyO1xuXG4gICAgLy8g4pSA4pSAIEhGIFRva2VuIFNlY3JldCAoZ3IwMHQgb25seSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgLy8gSHVnZ2luZ0ZhY2UgdG9rZW4g4oCUIG1vZGVsIHByZS1iYWtlIGF0IGJ1aWxkIHRpbWUgKEJ1aWxkS2l0IHNlY3JldCBtb3VudCkuXG4gICAgLy8gU3RvcmUgcGxhaW4tdGV4dCBIRiB0b2tlbiAoaGZfeHh4Li4uKSBhdCB0aGlzIHNlY3JldCBuYW1lLlxuICAgIC8vIE92ZXJyaWRlIHZpYSBDREsgY29udGV4dDogLWMgaGZUb2tlblNlY3JldE5hbWU9PG5hbWU+XG4gICAgY29uc3QgaGZUb2tlblNlY3JldE5hbWUgPSBjb25maWcuaGZUb2tlblNlY3JldE5hbWVcbiAgICAgID8gKHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdoZlRva2VuU2VjcmV0TmFtZScpIGFzIHN0cmluZyA/PyBjb25maWcuaGZUb2tlblNlY3JldE5hbWUpXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBoZlRva2VuU2VjcmV0ID0gaGZUb2tlblNlY3JldE5hbWVcbiAgICAgID8gc20uU2VjcmV0LmZyb21TZWNyZXROYW1lVjIodGhpcywgJ0hmVG9rZW5TZWNyZXQnLCBoZlRva2VuU2VjcmV0TmFtZSlcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgLy8g4pSA4pSAIERvY2tlciBzb3VyY2U6IFMzIEFzc2V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIC8vIENESyB6aXBzIHRoZSBkb2NrZXIvPG1vZGVsPi8gZGlyZWN0b3J5IGF0IGRlcGxveSB0aW1lIGFuZCB1cGxvYWRzIHRvIHRoZSBDREtcbiAgICAvLyBib290c3RyYXAgUzMgYnVja2V0LiBDb2RlQnVpbGQgZG93bmxvYWRzIGFuZCB1bnppcHMgaXQgYXV0b21hdGljYWxseS5cbiAgICAvLyBXaGVuIGRvY2tlci88bW9kZWw+LyBjaGFuZ2VzLCByZS1ydW4gYGNkayBkZXBsb3kgPE1vZGVsPkJ1aWxkU3RhY2tgIHRvIHJlLXN5bmMuXG4gICAgY29uc3QgZG9ja2VyU291cmNlID0gbmV3IHMzYXNzZXRzLkFzc2V0KHRoaXMsICdEb2NrZXJTb3VyY2UnLCB7XG4gICAgICBwYXRoOiBwYXRoLmpvaW4oX19kaXJuYW1lLCBkb2NrZXJDb250ZXh0RGlyKSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBFQ1IgUmVwb3NpdG9yeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICB0aGlzLmVjclJlcG8gPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ0VjclJlcG8nLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogY29uZmlnLmVjclJlcG9OYW1lLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgSUFNIFJvbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgYnVpbGRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdCdWlsZFJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY29kZWJ1aWxkLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcbiAgICB0aGlzLmVjclJlcG8uZ3JhbnRQdWxsUHVzaChidWlsZFJvbGUpO1xuICAgIGJ1aWxkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuICAgIGlmIChoZlRva2VuU2VjcmV0KSBoZlRva2VuU2VjcmV0LmdyYW50UmVhZChidWlsZFJvbGUpO1xuICAgIGRvY2tlclNvdXJjZS5ncmFudFJlYWQoYnVpbGRSb2xlKTtcblxuICAgIC8vIOKUgOKUgCBCdWlsZFNwZWMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgYnVpbGRDb21tYW5kcyA9IGhmVG9rZW5TZWNyZXROYW1lXG4gICAgICA/IFtcbiAgICAgICAgICAvLyBET0NLRVJfQlVJTERLSVQ9MTogcmVxdWlyZWQgZm9yIC0tc2VjcmV0IG1vdW50LlxuICAgICAgICAgIC8vIC0tc2VjcmV0IGlkPWhmX3Rva2VuLGVudj1IRl9UT0tFTjogcGFzc2VzIFNNIHNlY3JldCBhcyBCdWlsZEtpdCBzZWNyZXRcbiAgICAgICAgICAvLyAgIChub3Qgc3RvcmVkIGluIGltYWdlIGxheWVyIGhpc3RvcnkpLlxuICAgICAgICAgIGBET0NLRVJfQlVJTERLSVQ9MSBkb2NrZXIgYnVpbGQgLS1zZWNyZXQgaWQ9aGZfdG9rZW4sZW52PUhGX1RPS0VOIC10ICR7Y29uZmlnLmltYWdlTmFtZX06JHtpbWFnZVRhZ30gLmAsXG4gICAgICAgICAgYGRvY2tlciB0YWcgJHtjb25maWcuaW1hZ2VOYW1lfToke2ltYWdlVGFnfSAke2FjY291bnR9LmRrci5lY3IuJHtyZWdpb259LmFtYXpvbmF3cy5jb20vJHtjb25maWcuZWNyUmVwb05hbWV9OiR7aW1hZ2VUYWd9YCxcbiAgICAgICAgXVxuICAgICAgOiBbXG4gICAgICAgICAgLy8gRE9DS0VSX0JVSUxES0lUPTEgaXMga2VwdCB0byBzdXBwb3J0IGRvY2tlcmZpbGU6MSBzeW50YXggZGlyZWN0aXZlIGluIERvY2tlcmZpbGUuXG4gICAgICAgICAgLy8gTm8gLS1zZWNyZXQgZmxhZyBuZWVkZWQ6IHBpMC41IGNoZWNrcG9pbnQgaXMgb24gR0NTIHB1YmxpYyBidWNrZXQuXG4gICAgICAgICAgYERPQ0tFUl9CVUlMREtJVD0xIGRvY2tlciBidWlsZCAtdCAke2NvbmZpZy5pbWFnZU5hbWV9OiR7aW1hZ2VUYWd9IC5gLFxuICAgICAgICAgIGBkb2NrZXIgdGFnICR7Y29uZmlnLmltYWdlTmFtZX06JHtpbWFnZVRhZ30gJHthY2NvdW50fS5ka3IuZWNyLiR7cmVnaW9ufS5hbWF6b25hd3MuY29tLyR7Y29uZmlnLmVjclJlcG9OYW1lfToke2ltYWdlVGFnfWAsXG4gICAgICAgIF07XG5cbiAgICBjb25zdCBlbnZTZWN0aW9uID0gaGZUb2tlblNlY3JldE5hbWVcbiAgICAgID8ge1xuICAgICAgICAgICdzZWNyZXRzLW1hbmFnZXInOiB7XG4gICAgICAgICAgICBIRl9UT0tFTjogaGZUb2tlblNlY3JldE5hbWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAvLyDilIDilIAgQ29kZUJ1aWxkIFByb2plY3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgLy8gU291cmNlOiBTMyBBc3NldCAoZG9ja2VyLzxtb2RlbD4vIGRpcmVjdG9yeSB6aXBwZWQgYXQgY2RrIGRlcGxveSB0aW1lKS5cbiAgICAvLyBDb2RlQnVpbGQgdW56aXBzIHRoZSBhc3NldCBpbnRvICRDT0RFQlVJTERfU1JDX0RJUiBhdXRvbWF0aWNhbGx5LlxuICAgIC8vICRDT0RFQlVJTERfU1JDX0RJUiBjb250ZW50cyA9IGRvY2tlci88bW9kZWw+LyBkaXJlY3RvcnkgKERvY2tlcmZpbGUsIHNlcnZlLnB5LCBldGMuKVxuICAgIG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCAnQnVpbGRQcm9qZWN0Jywge1xuICAgICAgcHJvamVjdE5hbWU6IGNvbmZpZy5jb2RlQnVpbGRQcm9qZWN0TmFtZSxcbiAgICAgIHJvbGU6IGJ1aWxkUm9sZSxcbiAgICAgIHNvdXJjZTogY29kZWJ1aWxkLlNvdXJjZS5zMyh7XG4gICAgICAgIGJ1Y2tldDogZG9ja2VyU291cmNlLmJ1Y2tldCxcbiAgICAgICAgcGF0aDogZG9ja2VyU291cmNlLnMzT2JqZWN0S2V5LFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLlNUQU5EQVJEXzdfMCxcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvbmZpZy5jb21wdXRlVHlwZSA/PyBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuTUVESVVNLFxuICAgICAgICBwcml2aWxlZ2VkOiB0cnVlLCAgLy8gcmVxdWlyZWQgZm9yIGRvY2tlciBidWlsZFxuICAgICAgfSxcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcbiAgICAgICAgdmVyc2lvbjogJzAuMicsXG4gICAgICAgIC4uLihlbnZTZWN0aW9uID8geyBlbnY6IGVudlNlY3Rpb24gfSA6IHt9KSxcbiAgICAgICAgcGhhc2VzOiB7XG4gICAgICAgICAgcHJlX2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICBgYXdzIGVjciBnZXQtbG9naW4tcGFzc3dvcmQgLS1yZWdpb24gJHtyZWdpb259IHwgZG9ja2VyIGxvZ2luIC0tdXNlcm5hbWUgQVdTIC0tcGFzc3dvcmQtc3RkaW4gJHthY2NvdW50fS5ka3IuZWNyLiR7cmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBidWlsZDoge1xuICAgICAgICAgICAgY29tbWFuZHM6IGJ1aWxkQ29tbWFuZHMsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBwb3N0X2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICBgZG9ja2VyIHB1c2ggJHthY2NvdW50fS5ka3IuZWNyLiR7cmVnaW9ufS5hbWF6b25hd3MuY29tLyR7Y29uZmlnLmVjclJlcG9OYW1lfToke2ltYWdlVGFnfWAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHRoaXMuZWNyUmVwb1VyaSA9IGAke3RoaXMuZWNyUmVwby5yZXBvc2l0b3J5VXJpfToke2ltYWdlVGFnfWA7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRWNyUmVwb1VyaScsICAgICAgIHsgdmFsdWU6IGAke3RoaXMuZWNyUmVwby5yZXBvc2l0b3J5VXJpfToke2ltYWdlVGFnfWAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0ltYWdlVGFnJywgICAgICAgICAgeyB2YWx1ZTogaW1hZ2VUYWcgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvZGVCdWlsZFByb2plY3QnLCB7IHZhbHVlOiBjb25maWcuY29kZUJ1aWxkUHJvamVjdE5hbWUgfSk7XG5cbiAgICAvLyDilIDilIAgY2RrLW5hZyBTdXBwcmVzc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLCByZWFzb246ICdTYW1wbGUgcHJvamVjdDogQ29kZUJ1aWxkIHVzZXMgYnVpbHQtaW4gQUVTLTI1NiBlbmNyeXB0aW9uLiBLTVMgQ01LIGFkZHMgY29zdCBhbmQgbWFuYWdlbWVudCBvdmVyaGVhZCBub3Qgd2FycmFudGVkIGZvciBhIHNhbXBsZSBkZXBsb3ltZW50LicgfSxcbiAgICBdKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhidWlsZFJvbGUsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ2J1aWxkUm9sZSB3aWxkY2FyZHM6ICgxKSBDREstZ2VuZXJhdGVkIFMzIGFzc2V0IGJ1Y2tldCBwZXJtaXNzaW9ucyAoR2V0QnVja2V0KiwgR2V0T2JqZWN0KiwgTGlzdCopIGZvciB0aGUgQ0RLIGJvb3RzdHJhcCBTMyBhc3NldCwgKDIpIENESy1nZW5lcmF0ZWQgQ29kZUJ1aWxkIGxvZy9yZXBvcnQgZ3JvdXAgd2lsZGNhcmRzIGZvciBwcm9qZWN0IGV4ZWN1dGlvbiwgKDMpIGVjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4gb24gcmVzb3VyY2UgKiBwZXIgRUNSIEFQSSBzcGVjaWZpY2F0aW9uIChyZXF1aXJlZCBmb3IgZG9ja2VyIGxvZ2luIHRvIEVDUiByZWdpc3RyeTsgRUNSIHB1c2gvcHVsbCB0byB0aGUgc3BlY2lmaWMgcmVwbyBpcyBzY29wZWQgdmlhIGdyYW50UHVsbFB1c2gpLicgfSxcbiAgICBdLCB0cnVlKTtcbiAgfVxufVxuIl19