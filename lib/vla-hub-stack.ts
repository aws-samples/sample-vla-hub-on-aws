import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { AzSelectorConstruct } from './az-selector.js';

// ── Per-model static configuration ───────────────────────────────────────────

/**
 * Single-GPU instance type fallback orders per model.
 *
 * GR00T: requires FlashAttention → Ampere GPU or newer (SM80+).
 *   g6: NVIDIA L4 (Ada Lovelace, SM89) ✅ preferred
 *   g5: NVIDIA A10G (Ampere, SM86)     ✅ alternative
 *   NOTE: g4dn (T4, SM75) and p3 (V100, SM70) are NOT supported.
 *
 * PI: uses JAX — FlashAttention is NOT required.
 *   g5: NVIDIA A10G (Ampere, SM86) ✅ preferred (24 GB VRAM)
 *   g6: NVIDIA L4 (Ada Lovelace, SM89) ✅ alternative
 */
const DEFAULT_INSTANCE_TYPES: Record<string, string[]> = {
  gr00t: [
    'g6.2xlarge',  // L4 × 1, 8 vCPU, 32 GB — preferred
    'g5.2xlarge',  // A10G × 1, 8 vCPU, 32 GB — g6 alternative
    'g6.xlarge',   // L4 × 1, 4 vCPU, 16 GB — fallback
    'g5.xlarge',   // A10G × 1, 4 vCPU, 16 GB — last resort
  ],
  pi: [
    'g5.2xlarge',  // A10G × 1, 8 vCPU, 32 GB — preferred
    'g5.xlarge',   // A10G × 1, 4 vCPU, 16 GB — fallback
    'g6.2xlarge',  // L4 × 1, 8 vCPU, 32 GB — g5 alternative
    'g6.xlarge',   // L4 × 1, 4 vCPU, 16 GB — last resort
  ],
  openvla: [
    'g5.2xlarge',  // A10G × 1, 24 GB VRAM — 7B BF16 (~14 GB) 적합 (preferred)
    'g5.xlarge',   // A10G × 1, 24 GB VRAM — capacity 부족 시 대안
    'g6.2xlarge',  // L4 × 1, 24 GB VRAM — g5 대안
    'g6.xlarge',   // L4 × 1, 24 GB VRAM — 최후 수단
  ],
  smolvla: [
    // SmolVLA 450M: VRAM ~2 GB만 필요 → xlarge(24GB) 충분
    'g5.xlarge',   // A10G × 1, 24 GB VRAM — preferred (가장 저렴)
    'g6.xlarge',   // L4 × 1, 24 GB VRAM — g5 대안
    'g5.2xlarge',  // A10G × 1 — capacity 부족 시
    'g6.2xlarge',  // L4 × 1 — 최후 수단
  ],
  lap: [
    // LAP-3B (JAX, PaliGemma-3B + Flow Matching): FlashAttention 불필요.
    // ~12-16 GB VRAM → xlarge(24 GB) 충분 (paper RTX4090 ~25Hz).
    'g6.xlarge',   // L4 × 1, 24 GB VRAM — preferred
    'g5.xlarge',   // A10G × 1, 24 GB VRAM — g6 대안
    'g6.2xlarge',  // L4 × 1 — capacity 부족 시
    'g5.2xlarge',  // A10G × 1 — 최후 수단
  ],
};

/** Model-level static config (version-independent). */
interface ModelStaticConfig {
  ecrRepoName: string;
  // true for pi (JAX): daemon.json must set nvidia as default runtime so ECS registers ecs.capability.nvidia-gpu
  // false for gr00t (PyTorch): ECS GPU AMI already includes nvidia runtime; no explicit override needed
  useNvidiaRuntime: boolean;
}

/** Per-version config that varies across model versions. */
interface ModelVersionConfig {
  clusterName: string;
  capacityProviderName: string;
  memoryReservationMiB: number;
  containerEnv: Record<string, string>;
  // true → attach shared EFS /models volume (model weights stored on EFS, not baked in Docker image)
  useEfsModels?: boolean;
}

const MODEL_STATIC_CONFIGS: Record<string, ModelStaticConfig> = {
  gr00t: {
    ecrRepoName: 'gr00t-realtime',
    useNvidiaRuntime: false,
  },
  pi: {
    ecrRepoName: 'vla-pi-realtime',
    useNvidiaRuntime: true,
  },
  openvla: {
    ecrRepoName: 'vla-openvla-realtime',
    useNvidiaRuntime: false,
  },
  smolvla: {
    ecrRepoName: 'vla-smolvla-realtime',
    useNvidiaRuntime: false,
  },
  lap: {
    ecrRepoName: 'vla-lap-realtime',
    useNvidiaRuntime: true,  // JAX (pi와 동일): daemon.json default-runtime=nvidia 필요
  },
};

// GR00T: N1 series — all require Ampere+ (FlashAttention).
// HF model IDs: https://huggingface.co/nvidia
const GR00T_VERSION_CONFIGS: Record<string, ModelVersionConfig> = {
  'N1': {
    clusterName: 'gr00t-realtime-n1',
    capacityProviderName: 'gr00t-gpu-cp-n1',
    memoryReservationMiB: 16384,  // N1-3B: ~14 GB model; 16 GB reservation on g5/g6.2xlarge
    containerEnv: {
      HF_MODEL_ID:    'nvidia/GR00T-N1-3B',
      EMBODIMENT_TAG: 'GR1',
    },
  },
  'N1.5': {
    clusterName: 'gr00t-realtime-n1-5',
    capacityProviderName: 'gr00t-gpu-cp-n1-5',
    memoryReservationMiB: 20480,  // N1.5-7B: ~16 GB model; 20 GB reservation on g5/g6.2xlarge (32 GB)
    containerEnv: {
      HF_MODEL_ID:    'nvidia/GR00T-N1.5-7B',
      EMBODIMENT_TAG: 'GR1',
    },
  },
  'N1.6': {
    clusterName: 'gr00t-realtime-n1-6',
    capacityProviderName: 'gr00t-gpu-cp-n1-6',
    memoryReservationMiB: 20480,  // N1.6-3B: ~12 GB model; 20 GB reservation on g5/g6.2xlarge (32 GB)
    useEfsModels: true,
    containerEnv: {
      HF_MODEL_ID:    'nvidia/GR00T-N1.6-3B',
      EMBODIMENT_TAG: 'GR1',
      HF_HOME:        '/models',
      HF_HUB_OFFLINE: '1',
    },
  },
  'N1.7': {
    clusterName: 'gr00t-realtime-n1-7',
    capacityProviderName: 'gr00t-gpu-cp-n1-7',
    memoryReservationMiB: 20480,  // N1.7-3B (Cosmos-Reason2-2B backbone): ~12 GB; 20 GB reservation on g6.2xlarge (32 GB)
    useEfsModels: true,
    containerEnv: {
      HF_MODEL_ID:          'nvidia/GR00T-N1.7-LIBERO',
      EMBODIMENT_TAG:       'LIBERO_PANDA',
      HF_HOME:              '/models',
      HF_HUB_OFFLINE:       '1',
      // transformers 4.57.x _patch_mistral_regex() calls HF API even when HF_HUB_OFFLINE=1
      TRANSFORMERS_OFFLINE: '1',
    },
  },
};

// π (pi): JAX-based — no FlashAttention requirement.
// Versions: 0.5, 0.6, 0.7
const PI_VERSION_CONFIGS: Record<string, ModelVersionConfig> = {
  '0.5': {
    clusterName: 'vla-pi-realtime-0-5',
    capacityProviderName: 'pi-gpu-cp-0-5',
    memoryReservationMiB: 12288,  // pi0.5: ~10 GB in JAX; 12 GB on g5.xlarge (~15.8 GB available)
    containerEnv: {
      MODEL_CONFIG:         'pi05_libero',
      MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi05_libero',
    },
  },
  '0.6': {
    clusterName: 'vla-pi-realtime-0-6',
    capacityProviderName: 'pi-gpu-cp-0-6',
    memoryReservationMiB: 14336,  // pi0.6: ~12 GB estimate; 14 GB reservation
    containerEnv: {
      MODEL_CONFIG:         'pi06_libero',
      MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi06_libero',
    },
  },
  '0.7': {
    clusterName: 'vla-pi-realtime-0-7',
    capacityProviderName: 'pi-gpu-cp-0-7',
    memoryReservationMiB: 16384,
    containerEnv: {
      MODEL_CONFIG:         'pi07_libero',
      MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi07_libero',
    },
  },
};

// OpenVLA: HuggingFace openvla/openvla-7b — LLaMA-7B backbone, PyTorch.
// Weights baked into Docker image (~14 GB BF16). No EFS required.
const OPENVLA_VERSION_CONFIGS: Record<string, ModelVersionConfig> = {
  '7b': {
    clusterName: 'vla-openvla-realtime-7b',
    capacityProviderName: 'openvla-gpu-cp-7b',
    // OpenVLA-7B BF16: ~14 GB VRAM; reserve 20 GB on g5.2xlarge (32 GB total RAM)
    memoryReservationMiB: 20480,
    containerEnv: {
      HF_MODEL_ID:         'openvla/openvla-7b',
      DEVICE:              'cuda:0',
      HF_HUB_OFFLINE:      '1',
      TRANSFORMERS_OFFLINE: '1',
    },
  },
};

// SmolVLA: HuggingFace LeRobot lerobot/smolvla_base — SmolVLM2-500M + Flow Matching, PyTorch.
// Weights baked into Docker image (~1 GB). No EFS required. Apache 2.0.
const SMOLVLA_VERSION_CONFIGS: Record<string, ModelVersionConfig> = {
  '450M': {
    clusterName: 'vla-smolvla-realtime-450m',
    capacityProviderName: 'smolvla-gpu-cp-450m',
    // SmolVLA 450M: ~1 GB 모델 + LeRobot/PyTorch runtime + headroom
    // g5.xlarge (15.8 GB 가용 RAM) 기준으로 8 GB reservation 여유
    memoryReservationMiB: 8192,
    containerEnv: {
      HF_MODEL_ID:          'lerobot/smolvla_base',
      DEVICE:               'cuda:0',
      HF_HUB_OFFLINE:       '1',
      TRANSFORMERS_OFFLINE: '1',
    },
  },
};

// LAP: github.com/lihzha/lap — PaliGemma-3B + Flow Matching action expert, JAX (openpi 기반).
// 가중치(체크포인트 ~12.4 GB)는 Docker 이미지에 bake-in (public HF repo, 토큰 불필요).
// 토크나이저(gs://big_vision/paligemma)도 빌드 시 OPENPI_DATA_HOME 캐시에 bake-in.
const LAP_VERSION_CONFIGS: Record<string, ModelVersionConfig> = {
  '3B': {
    clusterName: 'vla-lap-realtime-3b',
    capacityProviderName: 'lap-gpu-cp-3b',
    // LAP-3B: JAX 런타임 ~12-16 GB; g6/g5.xlarge (~15.8 GB available)에 12 GB reservation
    memoryReservationMiB: 12288,
    containerEnv: {
      MODEL_CONFIG:         'lap_libero',
      MODEL_CHECKPOINT_DIR: '/opt/lap-cache/checkpoints/lap_libero',
      // openpi maybe_download 캐시 — 빌드 시 토크나이저 bake-in한 경로와 동일해야 캐시 히트
      OPENPI_DATA_HOME:     '/opt/openpi-cache',
    },
  },
};

const MODEL_VERSION_CONFIGS: Record<string, Record<string, ModelVersionConfig>> = {
  gr00t: GR00T_VERSION_CONFIGS,
  pi: PI_VERSION_CONFIGS,
  openvla: OPENVLA_VERSION_CONFIGS,
  smolvla: SMOLVLA_VERSION_CONFIGS,
  lap: LAP_VERSION_CONFIGS,
};

function resolveVersionConfig(modelId: string, version: string): ModelVersionConfig {
  const versionMap = MODEL_VERSION_CONFIGS[modelId];
  if (!versionMap) {
    throw new Error(`Unknown modelId '${modelId}'. Add an entry to MODEL_VERSION_CONFIGS.`);
  }
  const cfg = versionMap[version];
  if (!cfg) {
    const valid = Object.keys(versionMap).join(', ');
    throw new Error(`Unknown version '${version}' for model '${modelId}'. Valid versions: ${valid}`);
  }
  return cfg;
}

// ── JSON config types ─────────────────────────────────────────────────────────

export interface ModelCapacityConfig {
  type: 'spot' | 'on-demand';
  min: number;
  max: number;
  instance_types?: string[];
}

export interface ModelConfig {
  id: string;
  version: string;
  grpc_port: number;
  capacity: ModelCapacityConfig;
  ecrImageUri?: string;  // override; defaults to <account>.dkr.ecr.<region>.amazonaws.com/<ecrRepoName>:<version>-latest
}

export interface VlaHubStackProps extends cdk.StackProps {
  models: ModelConfig[];
}

// ── VlaHubStack ───────────────────────────────────────────────────────────────

export class VlaHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VlaHubStackProps) {
    super(scope, id, props);

    // ── Shared VPC ────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,              cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    NagSuppressions.addResourceSuppressions(vpc, [
      { id: 'AwsSolutions-VPC7', reason: 'Sample project: VPC Flow Logs add cost and operational overhead not warranted for a demo deployment.' },
    ]);

    // ── Shared EFS (model weights — mounted by EFS-enabled model versions) ────
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc,
      description: 'EFS gr00t-models - NFS inbound from ECS GPU instances',
      allowAllOutbound: false,
    });

    const efsFileSystem = new efs.FileSystem(this, 'GrootModelEfs', {
      vpc,
      fileSystemName: 'gr00t-models',
      throughputMode: efs.ThroughputMode.BURSTING,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      securityGroup: efsSecurityGroup,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const efsAccessPoint = new efs.AccessPoint(this, 'GrootModelAp', {
      fileSystem: efsFileSystem,
      path: '/models',
      createAcl: { ownerUid: '0', ownerGid: '0', permissions: '755' },
      posixUser: { uid: '0', gid: '0' },
    });

    NagSuppressions.addResourceSuppressions(efsFileSystem, [
      { id: 'AwsSolutions-EFS1', reason: 'EFS backup not required for model weights — weights are re-downloadable from HuggingFace.' },
    ], true);

    // ── Shared internal NLB ───────────────────────────────────────────────────
    const nlb = new elbv2.NetworkLoadBalancer(this, 'GrpcNlb', {
      vpc,
      internetFacing: false,
    });

    NagSuppressions.addResourceSuppressions(nlb, [
      { id: 'AwsSolutions-ELB2', reason: 'Sample project: NLB access logging adds S3 storage cost not warranted for a demo deployment.' },
    ]);

    // ── Per-model ECS + ASG ───────────────────────────────────────────────────
    for (const model of props.models) {
      this.addModelService(vpc, nlb, model, efsFileSystem, efsAccessPoint, efsSecurityGroup);
    }

    // Stack-level suppression for CDK-generated DrainECSHook ServiceRole wildcards.
    // cdk-nag granular rules require appliesTo but the ASG resource ARN contains a CFN
    // logical ID token that cannot be predicted at synth time — stack-level suppression is the
    // only reliable way to silence these CDK-internal findings.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK-generated ECS drain lifecycle hook Lambda ServiceRole. ASG resource ARN wildcard (autoScalingGroup:*:autoScalingGroupName/<token>) and ecs:* wildcards are required by CDK\'s built-in drain hook implementation and cannot be scoped further.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'CDK-generated ECS drain lifecycle hook Lambda ServiceRole. AWSLambdaBasicExecutionRole is the minimum required managed policy for Lambda CloudWatch Logs access.',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK-generated ECS drain lifecycle hook Lambda. Runtime version is managed by CDK internally.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'CDK-generated ECS drain lifecycle hook SNS topic. SSL enforcement not applicable to internally-triggered lifecycle notifications.',
      },
    ]);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: nlb.loadBalancerDnsName,
      description: 'Shared internal NLB DNS name (VPC-only). Connect on model-specific gRPC ports.',
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID - place gRPC client EC2 in this VPC to reach the NLB',
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: vpc.privateSubnets.map(s => s.subnetId).join(','),
      description: 'Private subnet IDs - place gRPC client EC2 in one of these subnets',
    });

    // ── SSM Parameters (consumed by enablement-pack deploy.py) ───────────────
    new ssm.StringParameter(this, 'SsmNlbDns', {
      parameterName: '/vla-hub/nlb-dns',
      stringValue: nlb.loadBalancerDnsName,
    });
    new ssm.StringParameter(this, 'SsmVpcId', {
      parameterName: '/vla-hub/vpc-id',
      stringValue: vpc.vpcId,
    });
    new ssm.StringParameter(this, 'SsmPrivateSubnetIds', {
      parameterName: '/vla-hub/private-subnet-ids',
      stringValue: vpc.privateSubnets.map(s => s.subnetId).join(','),
    });
  }

  private addModelService(
    vpc: ec2.Vpc,
    nlb: elbv2.NetworkLoadBalancer,
    model: ModelConfig,
    efsFileSystem: efs.FileSystem,
    efsAccessPoint: efs.AccessPoint,
    efsSecurityGroup: ec2.SecurityGroup,
  ): void {
    const { id: modelId, version, grpc_port: grpcPort, capacity } = model;
    const staticCfg  = MODEL_STATIC_CONFIGS[modelId];
    if (!staticCfg) {
      throw new Error(`Unknown modelId '${modelId}'. Add an entry to MODEL_STATIC_CONFIGS.`);
    }
    const versionCfg = resolveVersionConfig(modelId, version);

    // Sanitize version for use in CloudFormation logical IDs (dots → dash, alphanumeric only).
    const versionSafe = version.replace(/[^a-zA-Z0-9]/g, '-');
    const instanceTypes = capacity.instance_types ?? DEFAULT_INSTANCE_TYPES[modelId] ?? ['g6.2xlarge'];
    // ECR image tag includes version so each version maps to a separate image tag.
    const ecrImageUri   = model.ecrImageUri
      ?? `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${staticCfg.ecrRepoName}:${version}-latest`;

    // Construct prefix for CFN logical IDs: e.g. "Gr00t-N1-6" or "Pi-0-5"
    const idPart      = modelId.charAt(0).toUpperCase() + modelId.slice(1);
    const prefix      = `${idPart}-${versionSafe}`;

    // ── AzSelector ─────────────────────────────────────────────────────────
    const ecsGpuAmi  = ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU);
    const probeAmiId = ecsGpuAmi.getImage(this).imageId;

    const azSelector = new AzSelectorConstruct(this, `${prefix}AzSelector`, {
      instanceTypes,
      amiId: probeAmiId,
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });

    // ── ECS Cluster ─────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, `${prefix}Cluster`, {
      vpc,
      clusterName: versionCfg.clusterName,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── GPU ASG ─────────────────────────────────────────────────────────────
    const selectedSubnet = ec2.Subnet.fromSubnetAttributes(this, `${prefix}AzSelectedSubnet`, {
      subnetId: azSelector.subnetId,
      availabilityZone: azSelector.availabilityZone,
    });

    const asg = new autoscaling.AutoScalingGroup(this, `${prefix}GpuAsg`, {
      vpc,
      vpcSubnets:       { subnets: [selectedSubnet] },
      instanceType:     new ec2.InstanceType(azSelector.resolvedInstanceType),
      machineImage:     ecsGpuAmi,
      minCapacity:      capacity.min,
      maxCapacity:      capacity.max,
      desiredCapacity:  capacity.min > 0 ? capacity.min : undefined,
      userData:         buildUserData(staticCfg.useNvidiaRuntime),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(50, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
        {
          // Docker data root — formatted and mounted via userdata
          deviceName: '/dev/xvdcz',
          volume: autoscaling.BlockDeviceVolume.ebs(200, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(asg, [
      { id: 'AwsSolutions-AS3',  reason: 'Sample project: ASG scaling notifications not required. The GPU ASG runs exactly 1 task per instance; scale events trigger only on ECS capacity changes.' },
      { id: 'AwsSolutions-EC23', reason: 'gRPC port is restricted to vpc.vpcCidrBlock only. The NLB is internal (not internet-facing); all gRPC clients must reside in the same VPC.' },
    ], true);

    // EFS NFS (port 2049) — ASG instances → EFS mount target
    if (versionCfg.useEfsModels) {
      efsSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(asg.connections.securityGroups[0].securityGroupId),
        ec2.Port.tcp(2049),
        `NFS from ${prefix} GPU ASG`,
      );
      asg.connections.allowTo(efsSecurityGroup, ec2.Port.tcp(2049), `NFS to EFS (${prefix})`);
    }

    const capacityProvider = new ecs.AsgCapacityProvider(this, `${prefix}GpuCapacityProvider`, {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      capacityProviderName: versionCfg.capacityProviderName,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    // ── Task Definition ─────────────────────────────────────────────────────
    const taskRole = new iam.Role(this, `${prefix}TaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    NagSuppressions.addResourceSuppressions(taskRole, [
      { id: 'AwsSolutions-IAM5', reason: 'SSM Session Manager (ECS Exec) requires ssmmessages:Create/OpenControlChannel and DataChannel on resource * — AWS-defined scope.' },
    ], true);

    const logGroup = new logs.LogGroup(this, `${prefix}LogGroup`, {
      logGroupName: `/ecs/${versionCfg.clusterName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.Ec2TaskDefinition(this, `${prefix}TaskDef`, {
      networkMode: ecs.NetworkMode.BRIDGE,
      taskRole,
    });

    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    NagSuppressions.addResourceSuppressions(taskDef, [
      { id: 'AwsSolutions-ECS2', reason: 'Container environment variables are non-sensitive model config identifiers, not secrets. Injecting them via SSM/SM would add unnecessary complexity for a sample project.' },
      { id: 'AwsSolutions-IAM5', reason: 'ecr:GetAuthorizationToken requires resource * per ECR API specification.' },
    ], true);

    // EFS volume — model weights live on EFS, not baked in Docker image
    if (versionCfg.useEfsModels) {
      taskDef.addVolume({
        name: 'gr00t-models',
        efsVolumeConfiguration: {
          fileSystemId: efsFileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: efsAccessPoint.accessPointId,
            iam: 'ENABLED',
          },
        },
      });

      // EFS elasticfilesystem access for the task execution role
      taskDef.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
          'elasticfilesystem:DescribeMountTargets',
        ],
        resources: [efsFileSystem.fileSystemArn],
      }));
    }

    const container = taskDef.addContainer(`${modelId}-${versionSafe}`, {
      image: ecs.ContainerImage.fromRegistry(ecrImageUri),
      memoryReservationMiB: versionCfg.memoryReservationMiB,
      gpuCount: 1,
      environment: { ...versionCfg.containerEnv, GRPC_PORT: String(grpcPort) },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: modelId,
        logGroup,
      }),
      portMappings: [
        // Fixed port mappings (hostPort == containerPort).
        // Safe because we run exactly 1 task per instance (1 GPU per host).
        { containerPort: grpcPort, hostPort: grpcPort  /* gRPC inference server */ },
        { containerPort: 8080,     hostPort: 8080      /* HTTP health server    */ },
      ],
      healthCheck: {
        // serve.py starts the HTTP health server only AFTER model loads.
        command:     ['CMD-SHELL', '/opt/ml/code/check_health.sh'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(10),
        retries:     3,
        startPeriod: cdk.Duration.seconds(300),
      },
    });

    if (versionCfg.useEfsModels) {
      container.addMountPoints({
        containerPath: '/models',
        sourceVolume: 'gr00t-models',
        readOnly: false,
      });
    }

    // ── ECS Service ─────────────────────────────────────────────────────────
    const desiredCount = capacity.min;

    const service = new ecs.Ec2Service(this, `${prefix}Service`, {
      cluster,
      taskDefinition: taskDef,
      desiredCount,
      capacityProviderStrategies: [{
        capacityProvider: capacityProvider.capacityProviderName,
        weight: 1,
      }],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      enableExecuteCommand: true,
      healthCheckGracePeriod: cdk.Duration.seconds(360),
    });

    // ── NLB Listener + Target Group ─────────────────────────────────────────
    // NLB is transparent at L4 — client IPs pass through to EC2 instance.
    asg.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(grpcPort),
      `gRPC :${grpcPort} from VPC (internal NLB)`,
    );
    asg.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8080),
      'NLB HTTP health check on fixed port 8080',
    );

    const listener = nlb.addListener(`${prefix}GrpcListener`, {
      port: grpcPort,
      protocol: elbv2.Protocol.TCP,
    });

    listener.addTargets(`${prefix}GrpcTarget`, {
      port: grpcPort,
      protocol: elbv2.Protocol.TCP,
      targets: [
        service.loadBalancerTarget({ containerName: `${modelId}-${versionSafe}`, containerPort: grpcPort }),
      ],
      healthCheck: {
        // HTTP health check on port 8080 (serve.py HTTP health server).
        // Returns 200 only after model is loaded.
        protocol: elbv2.Protocol.HTTP,
        port: '8080',
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // NLB SG: allow health check and traffic forwarding
    nlb.connections.allowTo(asg, ec2.Port.tcp(8080),    `NLB to EC2 HTTP health check (${modelId})`);
    nlb.connections.allowTo(asg, ec2.Port.tcp(grpcPort), `NLB to EC2 gRPC :${grpcPort} (${modelId})`);
    nlb.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(grpcPort),
      `gRPC :${grpcPort} clients within VPC`,
    );

    NagSuppressions.addResourceSuppressions(nlb, [
      { id: 'AwsSolutions-EC23', reason: 'Internal NLB: gRPC port is restricted to vpc.vpcCidrBlock. No public internet access — VPC-level isolation enforced.' },
    ], true);

    // ── ECS Service Auto Scaling ─────────────────────────────────────────────
    // GPU instance startup (EC2 boot + ECS agent + model load) takes ~10 min.
    // Scale-in cooldown set to 15 min to prevent flapping.
    const scaling = service.autoScaleTaskCount({
      minCapacity: capacity.min,
      maxCapacity: capacity.max,
    });

    scaling.scaleOnCpuUtilization(`${prefix}CpuScaling`, {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.minutes(2),
      scaleInCooldown:  cdk.Duration.minutes(15),
    });

    // ── Per-model Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, `${prefix}GrpcEndpoint`, {
      value: `${nlb.loadBalancerDnsName}:${grpcPort}`,
      description: `gRPC inference endpoint for ${modelId}@${version} (internal NLB - VPC-only).`,
    });
    new cdk.CfnOutput(this, `${prefix}SelectedInstanceType`, {
      value: azSelector.resolvedInstanceType,
      description: `GPU instance type selected by AzSelector for ${modelId}@${version}`,
    });
    new cdk.CfnOutput(this, `${prefix}SelectedAZ`, {
      value: azSelector.availabilityZone,
      description: `Availability zone selected by AzSelector for ${modelId}@${version}`,
    });

    // SSM: /vla-hub/<modelId>/<version-safe>/grpc-endpoint (consumed by enablement-pack deploy.py)
    new ssm.StringParameter(this, `${prefix}SsmGrpcEndpoint`, {
      parameterName: `/vla-hub/${modelId}/${versionSafe.toLowerCase()}/grpc-endpoint`,
      stringValue: `${nlb.loadBalancerDnsName}:${grpcPort}`,
    });
  }
}

// ── UserData builder ──────────────────────────────────────────────────────────

function buildUserData(useNvidiaRuntime: boolean): ec2.UserData {
  const ud = ec2.UserData.forLinux();

  const daemonJson = useNvidiaRuntime
    ? '{"data-root": "/var/lib/docker-data", "default-runtime": "nvidia", "runtimes": {"nvidia": {"path": "nvidia-container-runtime", "runtimeArgs": []}}}'
    : '{"data-root": "/var/lib/docker-data"}';

  ud.addCommands(
    'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config',
    'systemctl stop ecs',
    'systemctl stop docker',
    'mkfs.xfs /dev/xvdcz',
    'mkdir -p /var/lib/docker-data',
    'mount /dev/xvdcz /var/lib/docker-data',
    'echo "/dev/xvdcz /var/lib/docker-data xfs defaults,nofail 0 2" >> /etc/fstab',
    'mkdir -p /etc/docker',
    `echo '${daemonJson}' > /etc/docker/daemon.json`,
    'systemctl start docker',
    'systemctl start --no-block ecs',
  );
  return ud;
}
