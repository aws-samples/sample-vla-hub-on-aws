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
exports.VlaHubStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const efs = __importStar(require("aws-cdk-lib/aws-efs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const autoscaling = __importStar(require("aws-cdk-lib/aws-autoscaling"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const cdk_nag_1 = require("cdk-nag");
const az_selector_js_1 = require("./az-selector.js");
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
const DEFAULT_INSTANCE_TYPES = {
    gr00t: [
        'g6.2xlarge', // L4 × 1, 8 vCPU, 32 GB — preferred
        'g5.2xlarge', // A10G × 1, 8 vCPU, 32 GB — g6 alternative
        'g6.xlarge', // L4 × 1, 4 vCPU, 16 GB — fallback
        'g5.xlarge', // A10G × 1, 4 vCPU, 16 GB — last resort
    ],
    pi: [
        'g5.2xlarge', // A10G × 1, 8 vCPU, 32 GB — preferred
        'g5.xlarge', // A10G × 1, 4 vCPU, 16 GB — fallback
        'g6.2xlarge', // L4 × 1, 8 vCPU, 32 GB — g5 alternative
        'g6.xlarge', // L4 × 1, 4 vCPU, 16 GB — last resort
    ],
    openvla: [
        'g5.2xlarge', // A10G × 1, 24 GB VRAM — 7B BF16 (~14 GB) 적합 (preferred)
        'g5.xlarge', // A10G × 1, 24 GB VRAM — capacity 부족 시 대안
        'g6.2xlarge', // L4 × 1, 24 GB VRAM — g5 대안
        'g6.xlarge', // L4 × 1, 24 GB VRAM — 최후 수단
    ],
    smolvla: [
        // SmolVLA 450M: VRAM ~2 GB만 필요 → xlarge(24GB) 충분
        'g5.xlarge', // A10G × 1, 24 GB VRAM — preferred (가장 저렴)
        'g6.xlarge', // L4 × 1, 24 GB VRAM — g5 대안
        'g5.2xlarge', // A10G × 1 — capacity 부족 시
        'g6.2xlarge', // L4 × 1 — 최후 수단
    ],
    lap: [
        // LAP-3B (JAX, PaliGemma-3B + Flow Matching): FlashAttention 불필요.
        // ~12-16 GB VRAM → xlarge(24 GB) 충분 (paper RTX4090 ~25Hz).
        'g6.xlarge', // L4 × 1, 24 GB VRAM — preferred
        'g5.xlarge', // A10G × 1, 24 GB VRAM — g6 대안
        'g6.2xlarge', // L4 × 1 — capacity 부족 시
        'g5.2xlarge', // A10G × 1 — 최후 수단
    ],
};
const MODEL_STATIC_CONFIGS = {
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
        useNvidiaRuntime: true, // JAX (pi와 동일): daemon.json default-runtime=nvidia 필요
    },
};
// GR00T: N1 series — all require Ampere+ (FlashAttention).
// HF model IDs: https://huggingface.co/nvidia
const GR00T_VERSION_CONFIGS = {
    'N1': {
        clusterName: 'gr00t-realtime-n1',
        capacityProviderName: 'gr00t-gpu-cp-n1',
        memoryReservationMiB: 16384, // N1-3B: ~14 GB model; 16 GB reservation on g5/g6.2xlarge
        containerEnv: {
            HF_MODEL_ID: 'nvidia/GR00T-N1-3B',
            EMBODIMENT_TAG: 'GR1',
        },
    },
    'N1.5': {
        clusterName: 'gr00t-realtime-n1-5',
        capacityProviderName: 'gr00t-gpu-cp-n1-5',
        memoryReservationMiB: 20480, // N1.5-7B: ~16 GB model; 20 GB reservation on g5/g6.2xlarge (32 GB)
        containerEnv: {
            HF_MODEL_ID: 'nvidia/GR00T-N1.5-7B',
            EMBODIMENT_TAG: 'GR1',
        },
    },
    'N1.6': {
        clusterName: 'gr00t-realtime-n1-6',
        capacityProviderName: 'gr00t-gpu-cp-n1-6',
        memoryReservationMiB: 20480, // N1.6-3B: ~12 GB model; 20 GB reservation on g5/g6.2xlarge (32 GB)
        useEfsModels: true,
        containerEnv: {
            HF_MODEL_ID: 'nvidia/GR00T-N1.6-3B',
            EMBODIMENT_TAG: 'GR1',
            HF_HOME: '/models',
            HF_HUB_OFFLINE: '1',
        },
    },
    'N1.7': {
        clusterName: 'gr00t-realtime-n1-7',
        capacityProviderName: 'gr00t-gpu-cp-n1-7',
        memoryReservationMiB: 20480, // N1.7-3B (Cosmos-Reason2-2B backbone): ~12 GB; 20 GB reservation on g6.2xlarge (32 GB)
        useEfsModels: true,
        containerEnv: {
            HF_MODEL_ID: 'nvidia/GR00T-N1.7-LIBERO',
            EMBODIMENT_TAG: 'LIBERO_PANDA',
            HF_HOME: '/models',
            HF_HUB_OFFLINE: '1',
            // transformers 4.57.x _patch_mistral_regex() calls HF API even when HF_HUB_OFFLINE=1
            TRANSFORMERS_OFFLINE: '1',
        },
    },
};
// π (pi): JAX-based — no FlashAttention requirement.
// Versions: 0.5, 0.6, 0.7
const PI_VERSION_CONFIGS = {
    '0.5': {
        clusterName: 'vla-pi-realtime-0-5',
        capacityProviderName: 'pi-gpu-cp-0-5',
        memoryReservationMiB: 12288, // pi0.5: ~10 GB in JAX; 12 GB on g5.xlarge (~15.8 GB available)
        containerEnv: {
            MODEL_CONFIG: 'pi05_libero',
            MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi05_libero',
        },
    },
    '0.6': {
        clusterName: 'vla-pi-realtime-0-6',
        capacityProviderName: 'pi-gpu-cp-0-6',
        memoryReservationMiB: 14336, // pi0.6: ~12 GB estimate; 14 GB reservation
        containerEnv: {
            MODEL_CONFIG: 'pi06_libero',
            MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi06_libero',
        },
    },
    '0.7': {
        clusterName: 'vla-pi-realtime-0-7',
        capacityProviderName: 'pi-gpu-cp-0-7',
        memoryReservationMiB: 16384,
        containerEnv: {
            MODEL_CONFIG: 'pi07_libero',
            MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi07_libero',
        },
    },
};
// OpenVLA: HuggingFace openvla/openvla-7b — LLaMA-7B backbone, PyTorch.
// Weights baked into Docker image (~14 GB BF16). No EFS required.
const OPENVLA_VERSION_CONFIGS = {
    '7b': {
        clusterName: 'vla-openvla-realtime-7b',
        capacityProviderName: 'openvla-gpu-cp-7b',
        // OpenVLA-7B BF16: ~14 GB VRAM; reserve 20 GB on g5.2xlarge (32 GB total RAM)
        memoryReservationMiB: 20480,
        containerEnv: {
            HF_MODEL_ID: 'openvla/openvla-7b',
            DEVICE: 'cuda:0',
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
        },
    },
};
// SmolVLA: HuggingFace LeRobot lerobot/smolvla_base — SmolVLM2-500M + Flow Matching, PyTorch.
// Weights baked into Docker image (~1 GB). No EFS required. Apache 2.0.
const SMOLVLA_VERSION_CONFIGS = {
    '450M': {
        clusterName: 'vla-smolvla-realtime-450m',
        capacityProviderName: 'smolvla-gpu-cp-450m',
        // SmolVLA 450M: ~1 GB 모델 + LeRobot/PyTorch runtime + headroom
        // g5.xlarge (15.8 GB 가용 RAM) 기준으로 8 GB reservation 여유
        memoryReservationMiB: 8192,
        containerEnv: {
            HF_MODEL_ID: 'lerobot/smolvla_base',
            DEVICE: 'cuda:0',
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
        },
    },
};
// LAP: github.com/lihzha/lap — PaliGemma-3B + Flow Matching action expert, JAX (openpi 기반).
// 가중치(체크포인트 ~12.4 GB)는 Docker 이미지에 bake-in (public HF repo, 토큰 불필요).
// 토크나이저(gs://big_vision/paligemma)도 빌드 시 OPENPI_DATA_HOME 캐시에 bake-in.
const LAP_VERSION_CONFIGS = {
    '3B': {
        clusterName: 'vla-lap-realtime-3b',
        capacityProviderName: 'lap-gpu-cp-3b',
        // LAP-3B: JAX 런타임 ~12-16 GB; g6/g5.xlarge (~15.8 GB available)에 12 GB reservation
        memoryReservationMiB: 12288,
        containerEnv: {
            MODEL_CONFIG: 'lap_libero',
            MODEL_CHECKPOINT_DIR: '/opt/lap-cache/checkpoints/lap_libero',
            // openpi maybe_download 캐시 — 빌드 시 토크나이저 bake-in한 경로와 동일해야 캐시 히트
            OPENPI_DATA_HOME: '/opt/openpi-cache',
        },
    },
};
const MODEL_VERSION_CONFIGS = {
    gr00t: GR00T_VERSION_CONFIGS,
    pi: PI_VERSION_CONFIGS,
    openvla: OPENVLA_VERSION_CONFIGS,
    smolvla: SMOLVLA_VERSION_CONFIGS,
    lap: LAP_VERSION_CONFIGS,
};
function resolveVersionConfig(modelId, version) {
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
// ── VlaHubStack ───────────────────────────────────────────────────────────────
class VlaHubStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ── Shared VPC ────────────────────────────────────────────────────────────
        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
            ],
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(vpc, [
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(efsFileSystem, [
            { id: 'AwsSolutions-EFS1', reason: 'EFS backup not required for model weights — weights are re-downloadable from HuggingFace.' },
        ], true);
        // ── Shared internal NLB ───────────────────────────────────────────────────
        const nlb = new elbv2.NetworkLoadBalancer(this, 'GrpcNlb', {
            vpc,
            internetFacing: false,
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(nlb, [
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
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
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
    addModelService(vpc, nlb, model, efsFileSystem, efsAccessPoint, efsSecurityGroup) {
        const { id: modelId, version, grpc_port: grpcPort, capacity } = model;
        const staticCfg = MODEL_STATIC_CONFIGS[modelId];
        if (!staticCfg) {
            throw new Error(`Unknown modelId '${modelId}'. Add an entry to MODEL_STATIC_CONFIGS.`);
        }
        const versionCfg = resolveVersionConfig(modelId, version);
        // Sanitize version for use in CloudFormation logical IDs (dots → dash, alphanumeric only).
        const versionSafe = version.replace(/[^a-zA-Z0-9]/g, '-');
        const instanceTypes = capacity.instance_types ?? DEFAULT_INSTANCE_TYPES[modelId] ?? ['g6.2xlarge'];
        // ECR image tag includes version so each version maps to a separate image tag.
        const ecrImageUri = model.ecrImageUri
            ?? `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${staticCfg.ecrRepoName}:${version}-latest`;
        // Construct prefix for CFN logical IDs: e.g. "Gr00t-N1-6" or "Pi-0-5"
        const idPart = modelId.charAt(0).toUpperCase() + modelId.slice(1);
        const prefix = `${idPart}-${versionSafe}`;
        // ── AzSelector ─────────────────────────────────────────────────────────
        const ecsGpuAmi = ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU);
        const probeAmiId = ecsGpuAmi.getImage(this).imageId;
        const azSelector = new az_selector_js_1.AzSelectorConstruct(this, `${prefix}AzSelector`, {
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
            vpcSubnets: { subnets: [selectedSubnet] },
            instanceType: new ec2.InstanceType(azSelector.resolvedInstanceType),
            machineImage: ecsGpuAmi,
            minCapacity: capacity.min,
            maxCapacity: capacity.max,
            desiredCapacity: capacity.min > 0 ? capacity.min : undefined,
            userData: buildUserData(staticCfg.useNvidiaRuntime),
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(asg, [
            { id: 'AwsSolutions-AS3', reason: 'Sample project: ASG scaling notifications not required. The GPU ASG runs exactly 1 task per instance; scale events trigger only on ECS capacity changes.' },
            { id: 'AwsSolutions-EC23', reason: 'gRPC port is restricted to vpc.vpcCidrBlock only. The NLB is internal (not internet-facing); all gRPC clients must reside in the same VPC.' },
        ], true);
        // EFS NFS (port 2049) — ASG instances → EFS mount target
        if (versionCfg.useEfsModels) {
            efsSecurityGroup.addIngressRule(ec2.Peer.securityGroupId(asg.connections.securityGroups[0].securityGroupId), ec2.Port.tcp(2049), `NFS from ${prefix} GPU ASG`);
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(taskRole, [
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(taskDef, [
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
                { containerPort: grpcPort, hostPort: grpcPort /* gRPC inference server */ },
                { containerPort: 8080, hostPort: 8080 /* HTTP health server    */ },
            ],
            healthCheck: {
                // serve.py starts the HTTP health server only AFTER model loads.
                command: ['CMD-SHELL', '/opt/ml/code/check_health.sh'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(10),
                retries: 3,
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
        asg.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(grpcPort), `gRPC :${grpcPort} from VPC (internal NLB)`);
        asg.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8080), 'NLB HTTP health check on fixed port 8080');
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
        nlb.connections.allowTo(asg, ec2.Port.tcp(8080), `NLB to EC2 HTTP health check (${modelId})`);
        nlb.connections.allowTo(asg, ec2.Port.tcp(grpcPort), `NLB to EC2 gRPC :${grpcPort} (${modelId})`);
        nlb.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(grpcPort), `gRPC :${grpcPort} clients within VPC`);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(nlb, [
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
            scaleInCooldown: cdk.Duration.minutes(15),
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
exports.VlaHubStack = VlaHubStack;
// ── UserData builder ──────────────────────────────────────────────────────────
function buildUserData(useNvidiaRuntime) {
    const ud = ec2.UserData.forLinux();
    const daemonJson = useNvidiaRuntime
        ? '{"data-root": "/var/lib/docker-data", "default-runtime": "nvidia", "runtimes": {"nvidia": {"path": "nvidia-container-runtime", "runtimeArgs": []}}}'
        : '{"data-root": "/var/lib/docker-data"}';
    ud.addCommands('echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config', 'systemctl stop ecs', 'systemctl stop docker', 'mkfs.xfs /dev/xvdcz', 'mkdir -p /var/lib/docker-data', 'mount /dev/xvdcz /var/lib/docker-data', 'echo "/dev/xvdcz /var/lib/docker-data xfs defaults,nofail 0 2" >> /etc/fstab', 'mkdir -p /etc/docker', `echo '${daemonJson}' > /etc/docker/daemon.json`, 'systemctl start docker', 'systemctl start --no-block ecs');
    return ud;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmxhLWh1Yi1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInZsYS1odWItc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyw4RUFBZ0U7QUFDaEUseUVBQTJEO0FBQzNELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFFM0MscUNBQTBDO0FBQzFDLHFEQUF1RDtBQUV2RCxnRkFBZ0Y7QUFFaEY7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxNQUFNLHNCQUFzQixHQUE2QjtJQUN2RCxLQUFLLEVBQUU7UUFDTCxZQUFZLEVBQUcsb0NBQW9DO1FBQ25ELFlBQVksRUFBRywyQ0FBMkM7UUFDMUQsV0FBVyxFQUFJLG1DQUFtQztRQUNsRCxXQUFXLEVBQUksd0NBQXdDO0tBQ3hEO0lBQ0QsRUFBRSxFQUFFO1FBQ0YsWUFBWSxFQUFHLHNDQUFzQztRQUNyRCxXQUFXLEVBQUkscUNBQXFDO1FBQ3BELFlBQVksRUFBRyx5Q0FBeUM7UUFDeEQsV0FBVyxFQUFJLHNDQUFzQztLQUN0RDtJQUNELE9BQU8sRUFBRTtRQUNQLFlBQVksRUFBRyx5REFBeUQ7UUFDeEUsV0FBVyxFQUFJLDBDQUEwQztRQUN6RCxZQUFZLEVBQUcsNkJBQTZCO1FBQzVDLFdBQVcsRUFBSSw2QkFBNkI7S0FDN0M7SUFDRCxPQUFPLEVBQUU7UUFDUCxpREFBaUQ7UUFDakQsV0FBVyxFQUFJLDJDQUEyQztRQUMxRCxXQUFXLEVBQUksNkJBQTZCO1FBQzVDLFlBQVksRUFBRywyQkFBMkI7UUFDMUMsWUFBWSxFQUFHLGlCQUFpQjtLQUNqQztJQUNELEdBQUcsRUFBRTtRQUNILGtFQUFrRTtRQUNsRSwyREFBMkQ7UUFDM0QsV0FBVyxFQUFJLGlDQUFpQztRQUNoRCxXQUFXLEVBQUksK0JBQStCO1FBQzlDLFlB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Q0FBQztDQUNGO0FBcGFELGtDQW9hQztBQUVELGlGQUFpRjtBQUVqRixTQUFTLGFBQWEsQ0FBQyxnQkFBeUI7SUFDOUMsTUFBTSxFQUFFLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztJQUVuQyxNQUFNLFVBQVUsR0FBRyxnQkFBZ0I7UUFDakMsQ0FBQyxDQUFDLHFKQUFxSjtRQUN2SixDQUFDLENBQUMsdUNBQXVDLENBQUM7SUFFNUMsRUFBRSxDQUFDLFdBQVcsQ0FDWix5REFBeUQsRUFDekQsb0JBQW9CLEVBQ3BCLHVCQUF1QixFQUN2QixxQkFBcUIsRUFDckIsK0JBQStCLEVBQy9CLHVDQUF1QyxFQUN2Qyw4RUFBOEUsRUFDOUUsc0JBQXNCLEVBQ3RCLFNBQVMsVUFBVSw2QkFBNkIsRUFDaEQsd0JBQXdCLEVBQ3hCLGdDQUFnQyxDQUNqQyxDQUFDO0lBQ0YsT0FBTyxFQUFFLENBQUM7QUFDWixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVmcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWZzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIHNzbSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3NtJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5pbXBvcnQgeyBBelNlbGVjdG9yQ29uc3RydWN0IH0gZnJvbSAnLi9hei1zZWxlY3Rvci5qcyc7XG5cbi8vIOKUgOKUgCBQZXItbW9kZWwgc3RhdGljIGNvbmZpZ3VyYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogU2luZ2xlLUdQVSBpbnN0YW5jZSB0eXBlIGZhbGxiYWNrIG9yZGVycyBwZXIgbW9kZWwuXG4gKlxuICogR1IwMFQ6IHJlcXVpcmVzIEZsYXNoQXR0ZW50aW9uIOKGkiBBbXBlcmUgR1BVIG9yIG5ld2VyIChTTTgwKykuXG4gKiAgIGc2OiBOVklESUEgTDQgKEFkYSBMb3ZlbGFjZSwgU004OSkg4pyFIHByZWZlcnJlZFxuICogICBnNTogTlZJRElBIEExMEcgKEFtcGVyZSwgU004NikgICAgIOKchSBhbHRlcm5hdGl2ZVxuICogICBOT1RFOiBnNGRuIChUNCwgU003NSkgYW5kIHAzIChWMTAwLCBTTTcwKSBhcmUgTk9UIHN1cHBvcnRlZC5cbiAqXG4gKiBQSTogdXNlcyBKQVgg4oCUIEZsYXNoQXR0ZW50aW9uIGlzIE5PVCByZXF1aXJlZC5cbiAqICAgZzU6IE5WSURJQSBBMTBHIChBbXBlcmUsIFNNODYpIOKchSBwcmVmZXJyZWQgKDI0IEdCIFZSQU0pXG4gKiAgIGc2OiBOVklESUEgTDQgKEFkYSBMb3ZlbGFjZSwgU004OSkg4pyFIGFsdGVybmF0aXZlXG4gKi9cbmNvbnN0IERFRkFVTFRfSU5TVEFOQ0VfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHtcbiAgZ3IwMHQ6IFtcbiAgICAnZzYuMnhsYXJnZScsICAvLyBMNCDDlyAxLCA4IHZDUFUsIDMyIEdCIOKAlCBwcmVmZXJyZWRcbiAgICAnZzUuMnhsYXJnZScsICAvLyBBMTBHIMOXIDEsIDggdkNQVSwgMzIgR0Ig4oCUIGc2IGFsdGVybmF0aXZlXG4gICAgJ2c2LnhsYXJnZScsICAgLy8gTDQgw5cgMSwgNCB2Q1BVLCAxNiBHQiDigJQgZmFsbGJhY2tcbiAgICAnZzUueGxhcmdlJywgICAvLyBBMTBHIMOXIDEsIDQgdkNQVSwgMTYgR0Ig4oCUIGxhc3QgcmVzb3J0XG4gIF0sXG4gIHBpOiBbXG4gICAgJ2c1LjJ4bGFyZ2UnLCAgLy8gQTEwRyDDlyAxLCA4IHZDUFUsIDMyIEdCIOKAlCBwcmVmZXJyZWRcbiAgICAnZzUueGxhcmdlJywgICAvLyBBMTBHIMOXIDEsIDQgdkNQVSwgMTYgR0Ig4oCUIGZhbGxiYWNrXG4gICAgJ2c2LjJ4bGFyZ2UnLCAgLy8gTDQgw5cgMSwgOCB2Q1BVLCAzMiBHQiDigJQgZzUgYWx0ZXJuYXRpdmVcbiAgICAnZzYueGxhcmdlJywgICAvLyBMNCDDlyAxLCA0IHZDUFUsIDE2IEdCIOKAlCBsYXN0IHJlc29ydFxuICBdLFxuICBvcGVudmxhOiBbXG4gICAgJ2c1LjJ4bGFyZ2UnLCAgLy8gQTEwRyDDlyAxLCAyNCBHQiBWUkFNIOKAlCA3QiBCRjE2ICh+MTQgR0IpIOygge2VqSAocHJlZmVycmVkKVxuICAgICdnNS54bGFyZ2UnLCAgIC8vIEExMEcgw5cgMSwgMjQgR0IgVlJBTSDigJQgY2FwYWNpdHkg67aA7KGxIOyLnCDrjIDslYhcbiAgICAnZzYuMnhsYXJnZScsICAvLyBMNCDDlyAxLCAyNCBHQiBWUkFNIOKAlCBnNSDrjIDslYhcbiAgICAnZzYueGxhcmdlJywgICAvLyBMNCDDlyAxLCAyNCBHQiBWUkFNIOKAlCDstZztm4Qg7IiY64uoXG4gIF0sXG4gIHNtb2x2bGE6IFtcbiAgICAvLyBTbW9sVkxBIDQ1ME06IFZSQU0gfjIgR0Lrp4wg7ZWE7JqUIOKGkiB4bGFyZ2UoMjRHQikg7Lap67aEXG4gICAgJ2c1LnhsYXJnZScsICAgLy8gQTEwRyDDlyAxLCAyNCBHQiBWUkFNIOKAlCBwcmVmZXJyZWQgKOqwgOyepSDsoIDroLQpXG4gICAgJ2c2LnhsYXJnZScsICAgLy8gTDQgw5cgMSwgMjQgR0IgVlJBTSDigJQgZzUg64yA7JWIXG4gICAgJ2c1LjJ4bGFyZ2UnLCAgLy8gQTEwRyDDlyAxIOKAlCBjYXBhY2l0eSDrtoDsobEg7IucXG4gICAgJ2c2LjJ4bGFyZ2UnLCAgLy8gTDQgw5cgMSDigJQg7LWc7ZuEIOyImOuLqFxuICBdLFxuICBsYXA6IFtcbiAgICAvLyBMQVAtM0IgKEpBWCwgUGFsaUdlbW1hLTNCICsgRmxvdyBNYXRjaGluZyk6IEZsYXNoQXR0ZW50aW9uIOu2iO2VhOyalC5cbiAgICAvLyB+MTItMTYgR0IgVlJBTSDihpIgeGxhcmdlKDI0IEdCKSDstqnrtoQgKHBhcGVyIFJUWDQwOTAgfjI1SHopLlxuICAgICdnNi54bGFyZ2UnLCAgIC8vIEw0IMOXIDEsIDI0IEdCIFZSQU0g4oCUIHByZWZlcnJlZFxuICAgICdnNS54bGFyZ2UnLCAgIC8vIEExMEcgw5cgMSwgMjQgR0IgVlJBTSDigJQgZzYg64yA7JWIXG4gICAgJ2c2LjJ4bGFyZ2UnLCAgLy8gTDQgw5cgMSDigJQgY2FwYWNpdHkg67aA7KGxIOyLnFxuICAgICdnNS4yeGxhcmdlJywgIC8vIEExMEcgw5cgMSDigJQg7LWc7ZuEIOyImOuLqFxuICBdLFxufTtcblxuLyoqIE1vZGVsLWxldmVsIHN0YXRpYyBjb25maWcgKHZlcnNpb24taW5kZXBlbmRlbnQpLiAqL1xuaW50ZXJmYWNlIE1vZGVsU3RhdGljQ29uZmlnIHtcbiAgZWNyUmVwb05hbWU6IHN0cmluZztcbiAgLy8gdHJ1ZSBmb3IgcGkgKEpBWCk6IGRhZW1vbi5qc29uIG11c3Qgc2V0IG52aWRpYSBhcyBkZWZhdWx0IHJ1bnRpbWUgc28gRUNTIHJlZ2lzdGVycyBlY3MuY2FwYWJpbGl0eS5udmlkaWEtZ3B1XG4gIC8vIGZhbHNlIGZvciBncjAwdCAoUHlUb3JjaCk6IEVDUyBHUFUgQU1JIGFscmVhZHkgaW5jbHVkZXMgbnZpZGlhIHJ1bnRpbWU7IG5vIGV4cGxpY2l0IG92ZXJyaWRlIG5lZWRlZFxuICB1c2VOdmlkaWFSdW50aW1lOiBib29sZWFuO1xufVxuXG4vKiogUGVyLXZlcnNpb24gY29uZmlnIHRoYXQgdmFyaWVzIGFjcm9zcyBtb2RlbCB2ZXJzaW9ucy4gKi9cbmludGVyZmFjZSBNb2RlbFZlcnNpb25Db25maWcge1xuICBjbHVzdGVyTmFtZTogc3RyaW5nO1xuICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogc3RyaW5nO1xuICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogbnVtYmVyO1xuICBjb250YWluZXJFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8vIHRydWUg4oaSIGF0dGFjaCBzaGFyZWQgRUZTIC9tb2RlbHMgdm9sdW1lIChtb2RlbCB3ZWlnaHRzIHN0b3JlZCBvbiBFRlMsIG5vdCBiYWtlZCBpbiBEb2NrZXIgaW1hZ2UpXG4gIHVzZUVmc01vZGVscz86IGJvb2xlYW47XG59XG5cbmNvbnN0IE1PREVMX1NUQVRJQ19DT05GSUdTOiBSZWNvcmQ8c3RyaW5nLCBNb2RlbFN0YXRpY0NvbmZpZz4gPSB7XG4gIGdyMDB0OiB7XG4gICAgZWNyUmVwb05hbWU6ICdncjAwdC1yZWFsdGltZScsXG4gICAgdXNlTnZpZGlhUnVudGltZTogZmFsc2UsXG4gIH0sXG4gIHBpOiB7XG4gICAgZWNyUmVwb05hbWU6ICd2bGEtcGktcmVhbHRpbWUnLFxuICAgIHVzZU52aWRpYVJ1bnRpbWU6IHRydWUsXG4gIH0sXG4gIG9wZW52bGE6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1vcGVudmxhLXJlYWx0aW1lJyxcbiAgICB1c2VOdmlkaWFSdW50aW1lOiBmYWxzZSxcbiAgfSxcbiAgc21vbHZsYToge1xuICAgIGVjclJlcG9OYW1lOiAndmxhLXNtb2x2bGEtcmVhbHRpbWUnLFxuICAgIHVzZU52aWRpYVJ1bnRpbWU6IGZhbHNlLFxuICB9LFxuICBsYXA6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1sYXAtcmVhbHRpbWUnLFxuICAgIHVzZU52aWRpYVJ1bnRpbWU6IHRydWUsICAvLyBKQVggKHBp7JmAIOuPmeydvCk6IGRhZW1vbi5qc29uIGRlZmF1bHQtcnVudGltZT1udmlkaWEg7ZWE7JqUXG4gIH0sXG59O1xuXG4vLyBHUjAwVDogTjEgc2VyaWVzIOKAlCBhbGwgcmVxdWlyZSBBbXBlcmUrIChGbGFzaEF0dGVudGlvbikuXG4vLyBIRiBtb2RlbCBJRHM6IGh0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vbnZpZGlhXG5jb25zdCBHUjAwVF9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4gPSB7XG4gICdOMSc6IHtcbiAgICBjbHVzdGVyTmFtZTogJ2dyMDB0LXJlYWx0aW1lLW4xJyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ2dyMDB0LWdwdS1jcC1uMScsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDE2Mzg0LCAgLy8gTjEtM0I6IH4xNCBHQiBtb2RlbDsgMTYgR0IgcmVzZXJ2YXRpb24gb24gZzUvZzYuMnhsYXJnZVxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgSEZfTU9ERUxfSUQ6ICAgICdudmlkaWEvR1IwMFQtTjEtM0InLFxuICAgICAgRU1CT0RJTUVOVF9UQUc6ICdHUjEnLFxuICAgIH0sXG4gIH0sXG4gICdOMS41Jzoge1xuICAgIGNsdXN0ZXJOYW1lOiAnZ3IwMHQtcmVhbHRpbWUtbjEtNScsXG4gICAgY2FwYWNpdHlQcm92aWRlck5hbWU6ICdncjAwdC1ncHUtY3AtbjEtNScsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDIwNDgwLCAgLy8gTjEuNS03QjogfjE2IEdCIG1vZGVsOyAyMCBHQiByZXNlcnZhdGlvbiBvbiBnNS9nNi4yeGxhcmdlICgzMiBHQilcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIEhGX01PREVMX0lEOiAgICAnbnZpZGlhL0dSMDBULU4xLjUtN0InLFxuICAgICAgRU1CT0RJTUVOVF9UQUc6ICdHUjEnLFxuICAgIH0sXG4gIH0sXG4gICdOMS42Jzoge1xuICAgIGNsdXN0ZXJOYW1lOiAnZ3IwMHQtcmVhbHRpbWUtbjEtNicsXG4gICAgY2FwYWNpdHlQcm92aWRlck5hbWU6ICdncjAwdC1ncHUtY3AtbjEtNicsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDIwNDgwLCAgLy8gTjEuNi0zQjogfjEyIEdCIG1vZGVsOyAyMCBHQiByZXNlcnZhdGlvbiBvbiBnNS9nNi4yeGxhcmdlICgzMiBHQilcbiAgICB1c2VFZnNNb2RlbHM6IHRydWUsXG4gICAgY29udGFpbmVyRW52OiB7XG4gICAgICBIRl9NT0RFTF9JRDogICAgJ252aWRpYS9HUjAwVC1OMS42LTNCJyxcbiAgICAgIEVNQk9ESU1FTlRfVEFHOiAnR1IxJyxcbiAgICAgIEhGX0hPTUU6ICAgICAgICAnL21vZGVscycsXG4gICAgICBIRl9IVUJfT0ZGTElORTogJzEnLFxuICAgIH0sXG4gIH0sXG4gICdOMS43Jzoge1xuICAgIGNsdXN0ZXJOYW1lOiAnZ3IwMHQtcmVhbHRpbWUtbjEtNycsXG4gICAgY2FwYWNpdHlQcm92aWRlck5hbWU6ICdncjAwdC1ncHUtY3AtbjEtNycsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDIwNDgwLCAgLy8gTjEuNy0zQiAoQ29zbW9zLVJlYXNvbjItMkIgYmFja2JvbmUpOiB+MTIgR0I7IDIwIEdCIHJlc2VydmF0aW9uIG9uIGc2LjJ4bGFyZ2UgKDMyIEdCKVxuICAgIHVzZUVmc01vZGVsczogdHJ1ZSxcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIEhGX01PREVMX0lEOiAgICAgICAgICAnbnZpZGlhL0dSMDBULU4xLjctTElCRVJPJyxcbiAgICAgIEVNQk9ESU1FTlRfVEFHOiAgICAgICAnTElCRVJPX1BBTkRBJyxcbiAgICAgIEhGX0hPTUU6ICAgICAgICAgICAgICAnL21vZGVscycsXG4gICAgICBIRl9IVUJfT0ZGTElORTogICAgICAgJzEnLFxuICAgICAgLy8gdHJhbnNmb3JtZXJzIDQuNTcueCBfcGF0Y2hfbWlzdHJhbF9yZWdleCgpIGNhbGxzIEhGIEFQSSBldmVuIHdoZW4gSEZfSFVCX09GRkxJTkU9MVxuICAgICAgVFJBTlNGT1JNRVJTX09GRkxJTkU6ICcxJyxcbiAgICB9LFxuICB9LFxufTtcblxuLy8gz4AgKHBpKTogSkFYLWJhc2VkIOKAlCBubyBGbGFzaEF0dGVudGlvbiByZXF1aXJlbWVudC5cbi8vIFZlcnNpb25zOiAwLjUsIDAuNiwgMC43XG5jb25zdCBQSV9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4gPSB7XG4gICcwLjUnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICd2bGEtcGktcmVhbHRpbWUtMC01JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ3BpLWdwdS1jcC0wLTUnLFxuICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiAxMjI4OCwgIC8vIHBpMC41OiB+MTAgR0IgaW4gSkFYOyAxMiBHQiBvbiBnNS54bGFyZ2UgKH4xNS44IEdCIGF2YWlsYWJsZSlcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIE1PREVMX0NPTkZJRzogICAgICAgICAncGkwNV9saWJlcm8nLFxuICAgICAgTU9ERUxfQ0hFQ0tQT0lOVF9ESVI6ICcvb3B0L3BpLWNhY2hlL2NoZWNrcG9pbnRzL3BpMDVfbGliZXJvJyxcbiAgICB9LFxuICB9LFxuICAnMC42Jzoge1xuICAgIGNsdXN0ZXJOYW1lOiAndmxhLXBpLXJlYWx0aW1lLTAtNicsXG4gICAgY2FwYWNpdHlQcm92aWRlck5hbWU6ICdwaS1ncHUtY3AtMC02JyxcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMTQzMzYsICAvLyBwaTAuNjogfjEyIEdCIGVzdGltYXRlOyAxNCBHQiByZXNlcnZhdGlvblxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgTU9ERUxfQ09ORklHOiAgICAgICAgICdwaTA2X2xpYmVybycsXG4gICAgICBNT0RFTF9DSEVDS1BPSU5UX0RJUjogJy9vcHQvcGktY2FjaGUvY2hlY2twb2ludHMvcGkwNl9saWJlcm8nLFxuICAgIH0sXG4gIH0sXG4gICcwLjcnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICd2bGEtcGktcmVhbHRpbWUtMC03JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ3BpLWdwdS1jcC0wLTcnLFxuICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiAxNjM4NCxcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIE1PREVMX0NPTkZJRzogICAgICAgICAncGkwN19saWJlcm8nLFxuICAgICAgTU9ERUxfQ0hFQ0tQT0lOVF9ESVI6ICcvb3B0L3BpLWNhY2hlL2NoZWNrcG9pbnRzL3BpMDdfbGliZXJvJyxcbiAgICB9LFxuICB9LFxufTtcblxuLy8gT3BlblZMQTogSHVnZ2luZ0ZhY2Ugb3BlbnZsYS9vcGVudmxhLTdiIOKAlCBMTGFNQS03QiBiYWNrYm9uZSwgUHlUb3JjaC5cbi8vIFdlaWdodHMgYmFrZWQgaW50byBEb2NrZXIgaW1hZ2UgKH4xNCBHQiBCRjE2KS4gTm8gRUZTIHJlcXVpcmVkLlxuY29uc3QgT1BFTlZMQV9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4gPSB7XG4gICc3Yic6IHtcbiAgICBjbHVzdGVyTmFtZTogJ3ZsYS1vcGVudmxhLXJlYWx0aW1lLTdiJyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ29wZW52bGEtZ3B1LWNwLTdiJyxcbiAgICAvLyBPcGVuVkxBLTdCIEJGMTY6IH4xNCBHQiBWUkFNOyByZXNlcnZlIDIwIEdCIG9uIGc1LjJ4bGFyZ2UgKDMyIEdCIHRvdGFsIFJBTSlcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMjA0ODAsXG4gICAgY29udGFpbmVyRW52OiB7XG4gICAgICBIRl9NT0RFTF9JRDogICAgICAgICAnb3BlbnZsYS9vcGVudmxhLTdiJyxcbiAgICAgIERFVklDRTogICAgICAgICAgICAgICdjdWRhOjAnLFxuICAgICAgSEZfSFVCX09GRkxJTkU6ICAgICAgJzEnLFxuICAgICAgVFJBTlNGT1JNRVJTX09GRkxJTkU6ICcxJyxcbiAgICB9LFxuICB9LFxufTtcblxuLy8gU21vbFZMQTogSHVnZ2luZ0ZhY2UgTGVSb2JvdCBsZXJvYm90L3Ntb2x2bGFfYmFzZSDigJQgU21vbFZMTTItNTAwTSArIEZsb3cgTWF0Y2hpbmcsIFB5VG9yY2guXG4vLyBXZWlnaHRzIGJha2VkIGludG8gRG9ja2VyIGltYWdlICh+MSBHQikuIE5vIEVGUyByZXF1aXJlZC4gQXBhY2hlIDIuMC5cbmNvbnN0IFNNT0xWTEFfVkVSU0lPTl9DT05GSUdTOiBSZWNvcmQ8c3RyaW5nLCBNb2RlbFZlcnNpb25Db25maWc+ID0ge1xuICAnNDUwTSc6IHtcbiAgICBjbHVzdGVyTmFtZTogJ3ZsYS1zbW9sdmxhLXJlYWx0aW1lLTQ1MG0nLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAnc21vbHZsYS1ncHUtY3AtNDUwbScsXG4gICAgLy8gU21vbFZMQSA0NTBNOiB+MSBHQiDrqqjrjbggKyBMZVJvYm90L1B5VG9yY2ggcnVudGltZSArIGhlYWRyb29tXG4gICAgLy8gZzUueGxhcmdlICgxNS44IEdCIOqwgOyaqSBSQU0pIOq4sOykgOycvOuhnCA4IEdCIHJlc2VydmF0aW9uIOyXrOycoFxuICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiA4MTkyLFxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgSEZfTU9ERUxfSUQ6ICAgICAgICAgICdsZXJvYm90L3Ntb2x2bGFfYmFzZScsXG4gICAgICBERVZJQ0U6ICAgICAgICAgICAgICAgJ2N1ZGE6MCcsXG4gICAgICBIRl9IVUJfT0ZGTElORTogICAgICAgJzEnLFxuICAgICAgVFJBTlNGT1JNRVJTX09GRkxJTkU6ICcxJyxcbiAgICB9LFxuICB9LFxufTtcblxuLy8gTEFQOiBnaXRodWIuY29tL2xpaHpoYS9sYXAg4oCUIFBhbGlHZW1tYS0zQiArIEZsb3cgTWF0Y2hpbmcgYWN0aW9uIGV4cGVydCwgSkFYIChvcGVucGkg6riw67CYKS5cbi8vIOqwgOykkey5mCjssrTtgaztj6zsnbjtirggfjEyLjQgR0Ip64qUIERvY2tlciDsnbTrr7jsp4Dsl5AgYmFrZS1pbiAocHVibGljIEhGIHJlcG8sIO2GoO2BsCDrtojtlYTsmpQpLlxuLy8g7Yag7YGs64KY7J207KCAKGdzOi8vYmlnX3Zpc2lvbi9wYWxpZ2VtbWEp64+EIOu5jOuTnCDsi5wgT1BFTlBJX0RBVEFfSE9NRSDsupDsi5zsl5AgYmFrZS1pbi5cbmNvbnN0IExBUF9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4gPSB7XG4gICczQic6IHtcbiAgICBjbHVzdGVyTmFtZTogJ3ZsYS1sYXAtcmVhbHRpbWUtM2InLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAnbGFwLWdwdS1jcC0zYicsXG4gICAgLy8gTEFQLTNCOiBKQVgg65+w7YOA7J6EIH4xMi0xNiBHQjsgZzYvZzUueGxhcmdlICh+MTUuOCBHQiBhdmFpbGFibGUp7JeQIDEyIEdCIHJlc2VydmF0aW9uXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDEyMjg4LFxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgTU9ERUxfQ09ORklHOiAgICAgICAgICdsYXBfbGliZXJvJyxcbiAgICAgIE1PREVMX0NIRUNLUE9JTlRfRElSOiAnL29wdC9sYXAtY2FjaGUvY2hlY2twb2ludHMvbGFwX2xpYmVybycsXG4gICAgICAvLyBvcGVucGkgbWF5YmVfZG93bmxvYWQg7LqQ7IucIOKAlCDruYzrk5wg7IucIO2GoO2BrOuCmOydtOyggCBiYWtlLWlu7ZWcIOqyveuhnOyZgCDrj5nsnbztlbTslbwg7LqQ7IucIO2eiO2KuFxuICAgICAgT1BFTlBJX0RBVEFfSE9NRTogICAgICcvb3B0L29wZW5waS1jYWNoZScsXG4gICAgfSxcbiAgfSxcbn07XG5cbmNvbnN0IE1PREVMX1ZFUlNJT05fQ09ORklHUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgTW9kZWxWZXJzaW9uQ29uZmlnPj4gPSB7XG4gIGdyMDB0OiBHUjAwVF9WRVJTSU9OX0NPTkZJR1MsXG4gIHBpOiBQSV9WRVJTSU9OX0NPTkZJR1MsXG4gIG9wZW52bGE6IE9QRU5WTEFfVkVSU0lPTl9DT05GSUdTLFxuICBzbW9sdmxhOiBTTU9MVkxBX1ZFUlNJT05fQ09ORklHUyxcbiAgbGFwOiBMQVBfVkVSU0lPTl9DT05GSUdTLFxufTtcblxuZnVuY3Rpb24gcmVzb2x2ZVZlcnNpb25Db25maWcobW9kZWxJZDogc3RyaW5nLCB2ZXJzaW9uOiBzdHJpbmcpOiBNb2RlbFZlcnNpb25Db25maWcge1xuICBjb25zdCB2ZXJzaW9uTWFwID0gTU9ERUxfVkVSU0lPTl9DT05GSUdTW21vZGVsSWRdO1xuICBpZiAoIXZlcnNpb25NYXApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gbW9kZWxJZCAnJHttb2RlbElkfScuIEFkZCBhbiBlbnRyeSB0byBNT0RFTF9WRVJTSU9OX0NPTkZJR1MuYCk7XG4gIH1cbiAgY29uc3QgY2ZnID0gdmVyc2lvbk1hcFt2ZXJzaW9uXTtcbiAgaWYgKCFjZmcpIHtcbiAgICBjb25zdCB2YWxpZCA9IE9iamVjdC5rZXlzKHZlcnNpb25NYXApLmpvaW4oJywgJyk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHZlcnNpb24gJyR7dmVyc2lvbn0nIGZvciBtb2RlbCAnJHttb2RlbElkfScuIFZhbGlkIHZlcnNpb25zOiAke3ZhbGlkfWApO1xuICB9XG4gIHJldHVybiBjZmc7XG59XG5cbi8vIOKUgOKUgCBKU09OIGNvbmZpZyB0eXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGludGVyZmFjZSBNb2RlbENhcGFjaXR5Q29uZmlnIHtcbiAgdHlwZTogJ3Nwb3QnIHwgJ29uLWRlbWFuZCc7XG4gIG1pbjogbnVtYmVyO1xuICBtYXg6IG51bWJlcjtcbiAgaW5zdGFuY2VfdHlwZXM/OiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNb2RlbENvbmZpZyB7XG4gIGlkOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZ3JwY19wb3J0OiBudW1iZXI7XG4gIGNhcGFjaXR5OiBNb2RlbENhcGFjaXR5Q29uZmlnO1xuICBlY3JJbWFnZVVyaT86IHN0cmluZzsgIC8vIG92ZXJyaWRlOyBkZWZhdWx0cyB0byA8YWNjb3VudD4uZGtyLmVjci48cmVnaW9uPi5hbWF6b25hd3MuY29tLzxlY3JSZXBvTmFtZT46PHZlcnNpb24+LWxhdGVzdFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFZsYUh1YlN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIG1vZGVsczogTW9kZWxDb25maWdbXTtcbn1cblxuLy8g4pSA4pSAIFZsYUh1YlN0YWNrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY2xhc3MgVmxhSHViU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogVmxhSHViU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8g4pSA4pSAIFNoYXJlZCBWUEMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1ZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7IG5hbWU6ICdwdWJsaWMnLCAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLCAgICAgICAgICAgICAgY2lkck1hc2s6IDI0IH0sXG4gICAgICAgIHsgbmFtZTogJ3ByaXZhdGUnLCBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLCBjaWRyTWFzazogMjQgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModnBjLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLVZQQzcnLCByZWFzb246ICdTYW1wbGUgcHJvamVjdDogVlBDIEZsb3cgTG9ncyBhZGQgY29zdCBhbmQgb3BlcmF0aW9uYWwgb3ZlcmhlYWQgbm90IHdhcnJhbnRlZCBmb3IgYSBkZW1vIGRlcGxveW1lbnQuJyB9LFxuICAgIF0pO1xuXG4gICAgLy8g4pSA4pSAIFNoYXJlZCBFRlMgKG1vZGVsIHdlaWdodHMg4oCUIG1vdW50ZWQgYnkgRUZTLWVuYWJsZWQgbW9kZWwgdmVyc2lvbnMpIOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IGVmc1NlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0Vmc1NnJywge1xuICAgICAgdnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdFRlMgZ3IwMHQtbW9kZWxzIC0gTkZTIGluYm91bmQgZnJvbSBFQ1MgR1BVIGluc3RhbmNlcycsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGVmc0ZpbGVTeXN0ZW0gPSBuZXcgZWZzLkZpbGVTeXN0ZW0odGhpcywgJ0dyb290TW9kZWxFZnMnLCB7XG4gICAgICB2cGMsXG4gICAgICBmaWxlU3lzdGVtTmFtZTogJ2dyMDB0LW1vZGVscycsXG4gICAgICB0aHJvdWdocHV0TW9kZTogZWZzLlRocm91Z2hwdXRNb2RlLkJVUlNUSU5HLFxuICAgICAgcGVyZm9ybWFuY2VNb2RlOiBlZnMuUGVyZm9ybWFuY2VNb2RlLkdFTkVSQUxfUFVSUE9TRSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGVmc1NlY3VyaXR5R3JvdXAsXG4gICAgICBlbmNyeXB0ZWQ6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgfSk7XG5cbiAgICBjb25zdCBlZnNBY2Nlc3NQb2ludCA9IG5ldyBlZnMuQWNjZXNzUG9pbnQodGhpcywgJ0dyb290TW9kZWxBcCcsIHtcbiAgICAgIGZpbGVTeXN0ZW06IGVmc0ZpbGVTeXN0ZW0sXG4gICAgICBwYXRoOiAnL21vZGVscycsXG4gICAgICBjcmVhdGVBY2w6IHsgb3duZXJVaWQ6ICcwJywgb3duZXJHaWQ6ICcwJywgcGVybWlzc2lvbnM6ICc3NTUnIH0sXG4gICAgICBwb3NpeFVzZXI6IHsgdWlkOiAnMCcsIGdpZDogJzAnIH0sXG4gICAgfSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoZWZzRmlsZVN5c3RlbSwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1FRlMxJywgcmVhc29uOiAnRUZTIGJhY2t1cCBub3QgcmVxdWlyZWQgZm9yIG1vZGVsIHdlaWdodHMg4oCUIHdlaWdodHMgYXJlIHJlLWRvd25sb2FkYWJsZSBmcm9tIEh1Z2dpbmdGYWNlLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIOKUgOKUgCBTaGFyZWQgaW50ZXJuYWwgTkxCIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IG5sYiA9IG5ldyBlbGJ2Mi5OZXR3b3JrTG9hZEJhbGFuY2VyKHRoaXMsICdHcnBjTmxiJywge1xuICAgICAgdnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKG5sYiwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1FTEIyJywgcmVhc29uOiAnU2FtcGxlIHByb2plY3Q6IE5MQiBhY2Nlc3MgbG9nZ2luZyBhZGRzIFMzIHN0b3JhZ2UgY29zdCBub3Qgd2FycmFudGVkIGZvciBhIGRlbW8gZGVwbG95bWVudC4nIH0sXG4gICAgXSk7XG5cbiAgICAvLyDilIDilIAgUGVyLW1vZGVsIEVDUyArIEFTRyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBmb3IgKGNvbnN0IG1vZGVsIG9mIHByb3BzLm1vZGVscykge1xuICAgICAgdGhpcy5hZGRNb2RlbFNlcnZpY2UodnBjLCBubGIsIG1vZGVsLCBlZnNGaWxlU3lzdGVtLCBlZnNBY2Nlc3NQb2ludCwgZWZzU2VjdXJpdHlHcm91cCk7XG4gICAgfVxuXG4gICAgLy8gU3RhY2stbGV2ZWwgc3VwcHJlc3Npb24gZm9yIENESy1nZW5lcmF0ZWQgRHJhaW5FQ1NIb29rIFNlcnZpY2VSb2xlIHdpbGRjYXJkcy5cbiAgICAvLyBjZGstbmFnIGdyYW51bGFyIHJ1bGVzIHJlcXVpcmUgYXBwbGllc1RvIGJ1dCB0aGUgQVNHIHJlc291cmNlIEFSTiBjb250YWlucyBhIENGTlxuICAgIC8vIGxvZ2ljYWwgSUQgdG9rZW4gdGhhdCBjYW5ub3QgYmUgcHJlZGljdGVkIGF0IHN5bnRoIHRpbWUg4oCUIHN0YWNrLWxldmVsIHN1cHByZXNzaW9uIGlzIHRoZVxuICAgIC8vIG9ubHkgcmVsaWFibGUgd2F5IHRvIHNpbGVuY2UgdGhlc2UgQ0RLLWludGVybmFsIGZpbmRpbmdzLlxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdDREstZ2VuZXJhdGVkIEVDUyBkcmFpbiBsaWZlY3ljbGUgaG9vayBMYW1iZGEgU2VydmljZVJvbGUuIEFTRyByZXNvdXJjZSBBUk4gd2lsZGNhcmQgKGF1dG9TY2FsaW5nR3JvdXA6KjphdXRvU2NhbGluZ0dyb3VwTmFtZS88dG9rZW4+KSBhbmQgZWNzOiogd2lsZGNhcmRzIGFyZSByZXF1aXJlZCBieSBDREtcXCdzIGJ1aWx0LWluIGRyYWluIGhvb2sgaW1wbGVtZW50YXRpb24gYW5kIGNhbm5vdCBiZSBzY29wZWQgZnVydGhlci4nLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXG4gICAgICAgIHJlYXNvbjogJ0NESy1nZW5lcmF0ZWQgRUNTIGRyYWluIGxpZmVjeWNsZSBob29rIExhbWJkYSBTZXJ2aWNlUm9sZS4gQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIHRoZSBtaW5pbXVtIHJlcXVpcmVkIG1hbmFnZWQgcG9saWN5IGZvciBMYW1iZGEgQ2xvdWRXYXRjaCBMb2dzIGFjY2Vzcy4nLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdDREstZ2VuZXJhdGVkIEVDUyBkcmFpbiBsaWZlY3ljbGUgaG9vayBMYW1iZGEuIFJ1bnRpbWUgdmVyc2lvbiBpcyBtYW5hZ2VkIGJ5IENESyBpbnRlcm5hbGx5LicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1TTlMzJyxcbiAgICAgICAgcmVhc29uOiAnQ0RLLWdlbmVyYXRlZCBFQ1MgZHJhaW4gbGlmZWN5Y2xlIGhvb2sgU05TIHRvcGljLiBTU0wgZW5mb3JjZW1lbnQgbm90IGFwcGxpY2FibGUgdG8gaW50ZXJuYWxseS10cmlnZ2VyZWQgbGlmZWN5Y2xlIG5vdGlmaWNhdGlvbnMuJyxcbiAgICAgIH0sXG4gICAgXSk7XG5cbiAgICAvLyDilIDilIAgT3V0cHV0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTmxiRG5zTmFtZScsIHtcbiAgICAgIHZhbHVlOiBubGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2hhcmVkIGludGVybmFsIE5MQiBETlMgbmFtZSAoVlBDLW9ubHkpLiBDb25uZWN0IG9uIG1vZGVsLXNwZWNpZmljIGdSUEMgcG9ydHMuJyxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVnBjSWQnLCB7XG4gICAgICB2YWx1ZTogdnBjLnZwY0lkLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgSUQgLSBwbGFjZSBnUlBDIGNsaWVudCBFQzIgaW4gdGhpcyBWUEMgdG8gcmVhY2ggdGhlIE5MQicsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1ByaXZhdGVTdWJuZXRJZHMnLCB7XG4gICAgICB2YWx1ZTogdnBjLnByaXZhdGVTdWJuZXRzLm1hcChzID0+IHMuc3VibmV0SWQpLmpvaW4oJywnKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBzdWJuZXQgSURzIC0gcGxhY2UgZ1JQQyBjbGllbnQgRUMyIGluIG9uZSBvZiB0aGVzZSBzdWJuZXRzJyxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBTU00gUGFyYW1ldGVycyAoY29uc3VtZWQgYnkgZW5hYmxlbWVudC1wYWNrIGRlcGxveS5weSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ1NzbU5sYkRucycsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6ICcvdmxhLWh1Yi9ubGItZG5zJyxcbiAgICAgIHN0cmluZ1ZhbHVlOiBubGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICB9KTtcbiAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCAnU3NtVnBjSWQnLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiAnL3ZsYS1odWIvdnBjLWlkJyxcbiAgICAgIHN0cmluZ1ZhbHVlOiB2cGMudnBjSWQsXG4gICAgfSk7XG4gICAgbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgJ1NzbVByaXZhdGVTdWJuZXRJZHMnLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiAnL3ZsYS1odWIvcHJpdmF0ZS1zdWJuZXQtaWRzJyxcbiAgICAgIHN0cmluZ1ZhbHVlOiB2cGMucHJpdmF0ZVN1Ym5ldHMubWFwKHMgPT4gcy5zdWJuZXRJZCkuam9pbignLCcpLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRNb2RlbFNlcnZpY2UoXG4gICAgdnBjOiBlYzIuVnBjLFxuICAgIG5sYjogZWxidjIuTmV0d29ya0xvYWRCYWxhbmNlcixcbiAgICBtb2RlbDogTW9kZWxDb25maWcsXG4gICAgZWZzRmlsZVN5c3RlbTogZWZzLkZpbGVTeXN0ZW0sXG4gICAgZWZzQWNjZXNzUG9pbnQ6IGVmcy5BY2Nlc3NQb2ludCxcbiAgICBlZnNTZWN1cml0eUdyb3VwOiBlYzIuU2VjdXJpdHlHcm91cCxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgeyBpZDogbW9kZWxJZCwgdmVyc2lvbiwgZ3JwY19wb3J0OiBncnBjUG9ydCwgY2FwYWNpdHkgfSA9IG1vZGVsO1xuICAgIGNvbnN0IHN0YXRpY0NmZyAgPSBNT0RFTF9TVEFUSUNfQ09ORklHU1ttb2RlbElkXTtcbiAgICBpZiAoIXN0YXRpY0NmZykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG1vZGVsSWQgJyR7bW9kZWxJZH0nLiBBZGQgYW4gZW50cnkgdG8gTU9ERUxfU1RBVElDX0NPTkZJR1MuYCk7XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25DZmcgPSByZXNvbHZlVmVyc2lvbkNvbmZpZyhtb2RlbElkLCB2ZXJzaW9uKTtcblxuICAgIC8vIFNhbml0aXplIHZlcnNpb24gZm9yIHVzZSBpbiBDbG91ZEZvcm1hdGlvbiBsb2dpY2FsIElEcyAoZG90cyDihpIgZGFzaCwgYWxwaGFudW1lcmljIG9ubHkpLlxuICAgIGNvbnN0IHZlcnNpb25TYWZlID0gdmVyc2lvbi5yZXBsYWNlKC9bXmEtekEtWjAtOV0vZywgJy0nKTtcbiAgICBjb25zdCBpbnN0YW5jZVR5cGVzID0gY2FwYWNpdHkuaW5zdGFuY2VfdHlwZXMgPz8gREVGQVVMVF9JTlNUQU5DRV9UWVBFU1ttb2RlbElkXSA/PyBbJ2c2LjJ4bGFyZ2UnXTtcbiAgICAvLyBFQ1IgaW1hZ2UgdGFnIGluY2x1ZGVzIHZlcnNpb24gc28gZWFjaCB2ZXJzaW9uIG1hcHMgdG8gYSBzZXBhcmF0ZSBpbWFnZSB0YWcuXG4gICAgY29uc3QgZWNySW1hZ2VVcmkgICA9IG1vZGVsLmVjckltYWdlVXJpXG4gICAgICA/PyBgJHt0aGlzLmFjY291bnR9LmRrci5lY3IuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3N0YXRpY0NmZy5lY3JSZXBvTmFtZX06JHt2ZXJzaW9ufS1sYXRlc3RgO1xuXG4gICAgLy8gQ29uc3RydWN0IHByZWZpeCBmb3IgQ0ZOIGxvZ2ljYWwgSURzOiBlLmcuIFwiR3IwMHQtTjEtNlwiIG9yIFwiUGktMC01XCJcbiAgICBjb25zdCBpZFBhcnQgICAgICA9IG1vZGVsSWQuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBtb2RlbElkLnNsaWNlKDEpO1xuICAgIGNvbnN0IHByZWZpeCAgICAgID0gYCR7aWRQYXJ0fS0ke3ZlcnNpb25TYWZlfWA7XG5cbiAgICAvLyDilIDilIAgQXpTZWxlY3RvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBlY3NHcHVBbWkgID0gZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MihlY3MuQW1pSGFyZHdhcmVUeXBlLkdQVSk7XG4gICAgY29uc3QgcHJvYmVBbWlJZCA9IGVjc0dwdUFtaS5nZXRJbWFnZSh0aGlzKS5pbWFnZUlkO1xuXG4gICAgY29uc3QgYXpTZWxlY3RvciA9IG5ldyBBelNlbGVjdG9yQ29uc3RydWN0KHRoaXMsIGAke3ByZWZpeH1BelNlbGVjdG9yYCwge1xuICAgICAgaW5zdGFuY2VUeXBlcyxcbiAgICAgIGFtaUlkOiBwcm9iZUFtaUlkLFxuICAgICAgc3VibmV0SWRzOiB2cGMucHJpdmF0ZVN1Ym5ldHMubWFwKHMgPT4gcy5zdWJuZXRJZCksXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgRUNTIENsdXN0ZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCBgJHtwcmVmaXh9Q2x1c3RlcmAsIHtcbiAgICAgIHZwYyxcbiAgICAgIGNsdXN0ZXJOYW1lOiB2ZXJzaW9uQ2ZnLmNsdXN0ZXJOYW1lLFxuICAgICAgY29udGFpbmVySW5zaWdodHNWMjogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOQUJMRUQsXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgR1BVIEFTRyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBzZWxlY3RlZFN1Ym5ldCA9IGVjMi5TdWJuZXQuZnJvbVN1Ym5ldEF0dHJpYnV0ZXModGhpcywgYCR7cHJlZml4fUF6U2VsZWN0ZWRTdWJuZXRgLCB7XG4gICAgICBzdWJuZXRJZDogYXpTZWxlY3Rvci5zdWJuZXRJZCxcbiAgICAgIGF2YWlsYWJpbGl0eVpvbmU6IGF6U2VsZWN0b3IuYXZhaWxhYmlsaXR5Wm9uZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFzZyA9IG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsIGAke3ByZWZpeH1HcHVBc2dgLCB7XG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzOiAgICAgICB7IHN1Ym5ldHM6IFtzZWxlY3RlZFN1Ym5ldF0gfSxcbiAgICAgIGluc3RhbmNlVHlwZTogICAgIG5ldyBlYzIuSW5zdGFuY2VUeXBlKGF6U2VsZWN0b3IucmVzb2x2ZWRJbnN0YW5jZVR5cGUpLFxuICAgICAgbWFjaGluZUltYWdlOiAgICAgZWNzR3B1QW1pLFxuICAgICAgbWluQ2FwYWNpdHk6ICAgICAgY2FwYWNpdHkubWluLFxuICAgICAgbWF4Q2FwYWNpdHk6ICAgICAgY2FwYWNpdHkubWF4LFxuICAgICAgZGVzaXJlZENhcGFjaXR5OiAgY2FwYWNpdHkubWluID4gMCA/IGNhcGFjaXR5Lm1pbiA6IHVuZGVmaW5lZCxcbiAgICAgIHVzZXJEYXRhOiAgICAgICAgIGJ1aWxkVXNlckRhdGEoc3RhdGljQ2ZnLnVzZU52aWRpYVJ1bnRpbWUpLFxuICAgICAgYmxvY2tEZXZpY2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBkZXZpY2VOYW1lOiAnL2Rldi94dmRhJyxcbiAgICAgICAgICB2b2x1bWU6IGF1dG9zY2FsaW5nLkJsb2NrRGV2aWNlVm9sdW1lLmVicyg1MCwge1xuICAgICAgICAgICAgdm9sdW1lVHlwZTogYXV0b3NjYWxpbmcuRWJzRGV2aWNlVm9sdW1lVHlwZS5HUDMsXG4gICAgICAgICAgICBlbmNyeXB0ZWQ6IHRydWUsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAvLyBEb2NrZXIgZGF0YSByb290IOKAlCBmb3JtYXR0ZWQgYW5kIG1vdW50ZWQgdmlhIHVzZXJkYXRhXG4gICAgICAgICAgZGV2aWNlTmFtZTogJy9kZXYveHZkY3onLFxuICAgICAgICAgIHZvbHVtZTogYXV0b3NjYWxpbmcuQmxvY2tEZXZpY2VWb2x1bWUuZWJzKDIwMCwge1xuICAgICAgICAgICAgdm9sdW1lVHlwZTogYXV0b3NjYWxpbmcuRWJzRGV2aWNlVm9sdW1lVHlwZS5HUDMsXG4gICAgICAgICAgICBlbmNyeXB0ZWQ6IHRydWUsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGFzZywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1BUzMnLCAgcmVhc29uOiAnU2FtcGxlIHByb2plY3Q6IEFTRyBzY2FsaW5nIG5vdGlmaWNhdGlvbnMgbm90IHJlcXVpcmVkLiBUaGUgR1BVIEFTRyBydW5zIGV4YWN0bHkgMSB0YXNrIHBlciBpbnN0YW5jZTsgc2NhbGUgZXZlbnRzIHRyaWdnZXIgb25seSBvbiBFQ1MgY2FwYWNpdHkgY2hhbmdlcy4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUVDMjMnLCByZWFzb246ICdnUlBDIHBvcnQgaXMgcmVzdHJpY3RlZCB0byB2cGMudnBjQ2lkckJsb2NrIG9ubHkuIFRoZSBOTEIgaXMgaW50ZXJuYWwgKG5vdCBpbnRlcm5ldC1mYWNpbmcpOyBhbGwgZ1JQQyBjbGllbnRzIG11c3QgcmVzaWRlIGluIHRoZSBzYW1lIFZQQy4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICAvLyBFRlMgTkZTIChwb3J0IDIwNDkpIOKAlCBBU0cgaW5zdGFuY2VzIOKGkiBFRlMgbW91bnQgdGFyZ2V0XG4gICAgaWYgKHZlcnNpb25DZmcudXNlRWZzTW9kZWxzKSB7XG4gICAgICBlZnNTZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICBlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQoYXNnLmNvbm5lY3Rpb25zLnNlY3VyaXR5R3JvdXBzWzBdLnNlY3VyaXR5R3JvdXBJZCksXG4gICAgICAgIGVjMi5Qb3J0LnRjcCgyMDQ5KSxcbiAgICAgICAgYE5GUyBmcm9tICR7cHJlZml4fSBHUFUgQVNHYCxcbiAgICAgICk7XG4gICAgICBhc2cuY29ubmVjdGlvbnMuYWxsb3dUbyhlZnNTZWN1cml0eUdyb3VwLCBlYzIuUG9ydC50Y3AoMjA0OSksIGBORlMgdG8gRUZTICgke3ByZWZpeH0pYCk7XG4gICAgfVxuXG4gICAgY29uc3QgY2FwYWNpdHlQcm92aWRlciA9IG5ldyBlY3MuQXNnQ2FwYWNpdHlQcm92aWRlcih0aGlzLCBgJHtwcmVmaXh9R3B1Q2FwYWNpdHlQcm92aWRlcmAsIHtcbiAgICAgIGF1dG9TY2FsaW5nR3JvdXA6IGFzZyxcbiAgICAgIGVuYWJsZU1hbmFnZWRTY2FsaW5nOiB0cnVlLFxuICAgICAgZW5hYmxlTWFuYWdlZFRlcm1pbmF0aW9uUHJvdGVjdGlvbjogZmFsc2UsXG4gICAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogdmVyc2lvbkNmZy5jYXBhY2l0eVByb3ZpZGVyTmFtZSxcbiAgICB9KTtcbiAgICBjbHVzdGVyLmFkZEFzZ0NhcGFjaXR5UHJvdmlkZXIoY2FwYWNpdHlQcm92aWRlcik7XG5cbiAgICAvLyDilIDilIAgVGFzayBEZWZpbml0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIGAke3ByZWZpeH1UYXNrUm9sZWAsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgdGFza1JvbGUuYWRkVG9QcmluY2lwYWxQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnc3NtbWVzc2FnZXM6Q3JlYXRlQ29udHJvbENoYW5uZWwnLFxuICAgICAgICAnc3NtbWVzc2FnZXM6Q3JlYXRlRGF0YUNoYW5uZWwnLFxuICAgICAgICAnc3NtbWVzc2FnZXM6T3BlbkNvbnRyb2xDaGFubmVsJyxcbiAgICAgICAgJ3NzbW1lc3NhZ2VzOk9wZW5EYXRhQ2hhbm5lbCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModGFza1JvbGUsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1NTTSBTZXNzaW9uIE1hbmFnZXIgKEVDUyBFeGVjKSByZXF1aXJlcyBzc21tZXNzYWdlczpDcmVhdGUvT3BlbkNvbnRyb2xDaGFubmVsIGFuZCBEYXRhQ2hhbm5lbCBvbiByZXNvdXJjZSAqIOKAlCBBV1MtZGVmaW5lZCBzY29wZS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIGAke3ByZWZpeH1Mb2dHcm91cGAsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9lY3MvJHt2ZXJzaW9uQ2ZnLmNsdXN0ZXJOYW1lfWAsXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCB0YXNrRGVmID0gbmV3IGVjcy5FYzJUYXNrRGVmaW5pdGlvbih0aGlzLCBgJHtwcmVmaXh9VGFza0RlZmAsIHtcbiAgICAgIG5ldHdvcmtNb2RlOiBlY3MuTmV0d29ya01vZGUuQlJJREdFLFxuICAgICAgdGFza1JvbGUsXG4gICAgfSk7XG5cbiAgICB0YXNrRGVmLmFkZFRvRXhlY3V0aW9uUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHRhc2tEZWYsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtRUNTMicsIHJlYXNvbjogJ0NvbnRhaW5lciBlbnZpcm9ubWVudCB2YXJpYWJsZXMgYXJlIG5vbi1zZW5zaXRpdmUgbW9kZWwgY29uZmlnIGlkZW50aWZpZXJzLCBub3Qgc2VjcmV0cy4gSW5qZWN0aW5nIHRoZW0gdmlhIFNTTS9TTSB3b3VsZCBhZGQgdW5uZWNlc3NhcnkgY29tcGxleGl0eSBmb3IgYSBzYW1wbGUgcHJvamVjdC4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuIHJlcXVpcmVzIHJlc291cmNlICogcGVyIEVDUiBBUEkgc3BlY2lmaWNhdGlvbi4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICAvLyBFRlMgdm9sdW1lIOKAlCBtb2RlbCB3ZWlnaHRzIGxpdmUgb24gRUZTLCBub3QgYmFrZWQgaW4gRG9ja2VyIGltYWdlXG4gICAgaWYgKHZlcnNpb25DZmcudXNlRWZzTW9kZWxzKSB7XG4gICAgICB0YXNrRGVmLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICdncjAwdC1tb2RlbHMnLFxuICAgICAgICBlZnNWb2x1bWVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgZmlsZVN5c3RlbUlkOiBlZnNGaWxlU3lzdGVtLmZpbGVTeXN0ZW1JZCxcbiAgICAgICAgICB0cmFuc2l0RW5jcnlwdGlvbjogJ0VOQUJMRUQnLFxuICAgICAgICAgIGF1dGhvcml6YXRpb25Db25maWc6IHtcbiAgICAgICAgICAgIGFjY2Vzc1BvaW50SWQ6IGVmc0FjY2Vzc1BvaW50LmFjY2Vzc1BvaW50SWQsXG4gICAgICAgICAgICBpYW06ICdFTkFCTEVEJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEVGUyBlbGFzdGljZmlsZXN5c3RlbSBhY2Nlc3MgZm9yIHRoZSB0YXNrIGV4ZWN1dGlvbiByb2xlXG4gICAgICB0YXNrRGVmLmFkZFRvVGFza1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudE1vdW50JyxcbiAgICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50V3JpdGUnLFxuICAgICAgICAgICdlbGFzdGljZmlsZXN5c3RlbTpDbGllbnRSb290QWNjZXNzJyxcbiAgICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06RGVzY3JpYmVNb3VudFRhcmdldHMnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtlZnNGaWxlU3lzdGVtLmZpbGVTeXN0ZW1Bcm5dLFxuICAgICAgfSkpO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWYuYWRkQ29udGFpbmVyKGAke21vZGVsSWR9LSR7dmVyc2lvblNhZmV9YCwge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoZWNySW1hZ2VVcmkpLFxuICAgICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IHZlcnNpb25DZmcubWVtb3J5UmVzZXJ2YXRpb25NaUIsXG4gICAgICBncHVDb3VudDogMSxcbiAgICAgIGVudmlyb25tZW50OiB7IC4uLnZlcnNpb25DZmcuY29udGFpbmVyRW52LCBHUlBDX1BPUlQ6IFN0cmluZyhncnBjUG9ydCkgfSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6IG1vZGVsSWQsXG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgICBwb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgLy8gRml4ZWQgcG9ydCBtYXBwaW5ncyAoaG9zdFBvcnQgPT0gY29udGFpbmVyUG9ydCkuXG4gICAgICAgIC8vIFNhZmUgYmVjYXVzZSB3ZSBydW4gZXhhY3RseSAxIHRhc2sgcGVyIGluc3RhbmNlICgxIEdQVSBwZXIgaG9zdCkuXG4gICAgICAgIHsgY29udGFpbmVyUG9ydDogZ3JwY1BvcnQsIGhvc3RQb3J0OiBncnBjUG9ydCAgLyogZ1JQQyBpbmZlcmVuY2Ugc2VydmVyICovIH0sXG4gICAgICAgIHsgY29udGFpbmVyUG9ydDogODA4MCwgICAgIGhvc3RQb3J0OiA4MDgwICAgICAgLyogSFRUUCBoZWFsdGggc2VydmVyICAgICovIH0sXG4gICAgICBdLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgLy8gc2VydmUucHkgc3RhcnRzIHRoZSBIVFRQIGhlYWx0aCBzZXJ2ZXIgb25seSBBRlRFUiBtb2RlbCBsb2Fkcy5cbiAgICAgICAgY29tbWFuZDogICAgIFsnQ01ELVNIRUxMJywgJy9vcHQvbWwvY29kZS9jaGVja19oZWFsdGguc2gnXSxcbiAgICAgICAgaW50ZXJ2YWw6ICAgIGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogICAgIGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgcmV0cmllczogICAgIDMsXG4gICAgICAgIHN0YXJ0UGVyaW9kOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMDApLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGlmICh2ZXJzaW9uQ2ZnLnVzZUVmc01vZGVscykge1xuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy9tb2RlbHMnLFxuICAgICAgICBzb3VyY2VWb2x1bWU6ICdncjAwdC1tb2RlbHMnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyDilIDilIAgRUNTIFNlcnZpY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgZGVzaXJlZENvdW50ID0gY2FwYWNpdHkubWluO1xuXG4gICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3MuRWMyU2VydmljZSh0aGlzLCBgJHtwcmVmaXh9U2VydmljZWAsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZixcbiAgICAgIGRlc2lyZWRDb3VudCxcbiAgICAgIGNhcGFjaXR5UHJvdmlkZXJTdHJhdGVnaWVzOiBbe1xuICAgICAgICBjYXBhY2l0eVByb3ZpZGVyOiBjYXBhY2l0eVByb3ZpZGVyLmNhcGFjaXR5UHJvdmlkZXJOYW1lLFxuICAgICAgICB3ZWlnaHQ6IDEsXG4gICAgICB9XSxcbiAgICAgIG1pbkhlYWx0aHlQZXJjZW50OiAwLFxuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IDEwMCxcbiAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0cnVlLFxuICAgICAgaGVhbHRoQ2hlY2tHcmFjZVBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzYwKSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBOTEIgTGlzdGVuZXIgKyBUYXJnZXQgR3JvdXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgLy8gTkxCIGlzIHRyYW5zcGFyZW50IGF0IEw0IOKAlCBjbGllbnQgSVBzIHBhc3MgdGhyb3VnaCB0byBFQzIgaW5zdGFuY2UuXG4gICAgYXNnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShcbiAgICAgIGVjMi5QZWVyLmlwdjQodnBjLnZwY0NpZHJCbG9jayksXG4gICAgICBlYzIuUG9ydC50Y3AoZ3JwY1BvcnQpLFxuICAgICAgYGdSUEMgOiR7Z3JwY1BvcnR9IGZyb20gVlBDIChpbnRlcm5hbCBOTEIpYCxcbiAgICApO1xuICAgIGFzZy5jb25uZWN0aW9ucy5hbGxvd0Zyb20oXG4gICAgICBlYzIuUGVlci5pcHY0KHZwYy52cGNDaWRyQmxvY2spLFxuICAgICAgZWMyLlBvcnQudGNwKDgwODApLFxuICAgICAgJ05MQiBIVFRQIGhlYWx0aCBjaGVjayBvbiBmaXhlZCBwb3J0IDgwODAnLFxuICAgICk7XG5cbiAgICBjb25zdCBsaXN0ZW5lciA9IG5sYi5hZGRMaXN0ZW5lcihgJHtwcmVmaXh9R3JwY0xpc3RlbmVyYCwge1xuICAgICAgcG9ydDogZ3JwY1BvcnQsXG4gICAgICBwcm90b2NvbDogZWxidjIuUHJvdG9jb2wuVENQLFxuICAgIH0pO1xuXG4gICAgbGlzdGVuZXIuYWRkVGFyZ2V0cyhgJHtwcmVmaXh9R3JwY1RhcmdldGAsIHtcbiAgICAgIHBvcnQ6IGdycGNQb3J0LFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLlByb3RvY29sLlRDUCxcbiAgICAgIHRhcmdldHM6IFtcbiAgICAgICAgc2VydmljZS5sb2FkQmFsYW5jZXJUYXJnZXQoeyBjb250YWluZXJOYW1lOiBgJHttb2RlbElkfS0ke3ZlcnNpb25TYWZlfWAsIGNvbnRhaW5lclBvcnQ6IGdycGNQb3J0IH0pLFxuICAgICAgXSxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIC8vIEhUVFAgaGVhbHRoIGNoZWNrIG9uIHBvcnQgODA4MCAoc2VydmUucHkgSFRUUCBoZWFsdGggc2VydmVyKS5cbiAgICAgICAgLy8gUmV0dXJucyAyMDAgb25seSBhZnRlciBtb2RlbCBpcyBsb2FkZWQuXG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5Qcm90b2NvbC5IVFRQLFxuICAgICAgICBwb3J0OiAnODA4MCcsXG4gICAgICAgIHBhdGg6ICcvaGVhbHRoJyxcbiAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAxMCxcbiAgICAgIH0sXG4gICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyBOTEIgU0c6IGFsbG93IGhlYWx0aCBjaGVjayBhbmQgdHJhZmZpYyBmb3J3YXJkaW5nXG4gICAgbmxiLmNvbm5lY3Rpb25zLmFsbG93VG8oYXNnLCBlYzIuUG9ydC50Y3AoODA4MCksICAgIGBOTEIgdG8gRUMyIEhUVFAgaGVhbHRoIGNoZWNrICgke21vZGVsSWR9KWApO1xuICAgIG5sYi5jb25uZWN0aW9ucy5hbGxvd1RvKGFzZywgZWMyLlBvcnQudGNwKGdycGNQb3J0KSwgYE5MQiB0byBFQzIgZ1JQQyA6JHtncnBjUG9ydH0gKCR7bW9kZWxJZH0pYCk7XG4gICAgbmxiLmNvbm5lY3Rpb25zLmFsbG93RnJvbShcbiAgICAgIGVjMi5QZWVyLmlwdjQodnBjLnZwY0NpZHJCbG9jayksXG4gICAgICBlYzIuUG9ydC50Y3AoZ3JwY1BvcnQpLFxuICAgICAgYGdSUEMgOiR7Z3JwY1BvcnR9IGNsaWVudHMgd2l0aGluIFZQQ2AsXG4gICAgKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhubGIsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtRUMyMycsIHJlYXNvbjogJ0ludGVybmFsIE5MQjogZ1JQQyBwb3J0IGlzIHJlc3RyaWN0ZWQgdG8gdnBjLnZwY0NpZHJCbG9jay4gTm8gcHVibGljIGludGVybmV0IGFjY2VzcyDigJQgVlBDLWxldmVsIGlzb2xhdGlvbiBlbmZvcmNlZC4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICAvLyDilIDilIAgRUNTIFNlcnZpY2UgQXV0byBTY2FsaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIC8vIEdQVSBpbnN0YW5jZSBzdGFydHVwIChFQzIgYm9vdCArIEVDUyBhZ2VudCArIG1vZGVsIGxvYWQpIHRha2VzIH4xMCBtaW4uXG4gICAgLy8gU2NhbGUtaW4gY29vbGRvd24gc2V0IHRvIDE1IG1pbiB0byBwcmV2ZW50IGZsYXBwaW5nLlxuICAgIGNvbnN0IHNjYWxpbmcgPSBzZXJ2aWNlLmF1dG9TY2FsZVRhc2tDb3VudCh7XG4gICAgICBtaW5DYXBhY2l0eTogY2FwYWNpdHkubWluLFxuICAgICAgbWF4Q2FwYWNpdHk6IGNhcGFjaXR5Lm1heCxcbiAgICB9KTtcblxuICAgIHNjYWxpbmcuc2NhbGVPbkNwdVV0aWxpemF0aW9uKGAke3ByZWZpeH1DcHVTY2FsaW5nYCwge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiA3MCxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDIpLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiAgY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTUpLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIFBlci1tb2RlbCBPdXRwdXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGAke3ByZWZpeH1HcnBjRW5kcG9pbnRgLCB7XG4gICAgICB2YWx1ZTogYCR7bmxiLmxvYWRCYWxhbmNlckRuc05hbWV9OiR7Z3JwY1BvcnR9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgZ1JQQyBpbmZlcmVuY2UgZW5kcG9pbnQgZm9yICR7bW9kZWxJZH1AJHt2ZXJzaW9ufSAoaW50ZXJuYWwgTkxCIC0gVlBDLW9ubHkpLmAsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgYCR7cHJlZml4fVNlbGVjdGVkSW5zdGFuY2VUeXBlYCwge1xuICAgICAgdmFsdWU6IGF6U2VsZWN0b3IucmVzb2x2ZWRJbnN0YW5jZVR5cGUsXG4gICAgICBkZXNjcmlwdGlvbjogYEdQVSBpbnN0YW5jZSB0eXBlIHNlbGVjdGVkIGJ5IEF6U2VsZWN0b3IgZm9yICR7bW9kZWxJZH1AJHt2ZXJzaW9ufWAsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgYCR7cHJlZml4fVNlbGVjdGVkQVpgLCB7XG4gICAgICB2YWx1ZTogYXpTZWxlY3Rvci5hdmFpbGFiaWxpdHlab25lLFxuICAgICAgZGVzY3JpcHRpb246IGBBdmFpbGFiaWxpdHkgem9uZSBzZWxlY3RlZCBieSBBelNlbGVjdG9yIGZvciAke21vZGVsSWR9QCR7dmVyc2lvbn1gLFxuICAgIH0pO1xuXG4gICAgLy8gU1NNOiAvdmxhLWh1Yi88bW9kZWxJZD4vPHZlcnNpb24tc2FmZT4vZ3JwYy1lbmRwb2ludCAoY29uc3VtZWQgYnkgZW5hYmxlbWVudC1wYWNrIGRlcGxveS5weSlcbiAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBgJHtwcmVmaXh9U3NtR3JwY0VuZHBvaW50YCwge1xuICAgICAgcGFyYW1ldGVyTmFtZTogYC92bGEtaHViLyR7bW9kZWxJZH0vJHt2ZXJzaW9uU2FmZS50b0xvd2VyQ2FzZSgpfS9ncnBjLWVuZHBvaW50YCxcbiAgICAgIHN0cmluZ1ZhbHVlOiBgJHtubGIubG9hZEJhbGFuY2VyRG5zTmFtZX06JHtncnBjUG9ydH1gLFxuICAgIH0pO1xuICB9XG59XG5cbi8vIOKUgOKUgCBVc2VyRGF0YSBidWlsZGVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5mdW5jdGlvbiBidWlsZFVzZXJEYXRhKHVzZU52aWRpYVJ1bnRpbWU6IGJvb2xlYW4pOiBlYzIuVXNlckRhdGEge1xuICBjb25zdCB1ZCA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xuXG4gIGNvbnN0IGRhZW1vbkpzb24gPSB1c2VOdmlkaWFSdW50aW1lXG4gICAgPyAne1wiZGF0YS1yb290XCI6IFwiL3Zhci9saWIvZG9ja2VyLWRhdGFcIiwgXCJkZWZhdWx0LXJ1bnRpbWVcIjogXCJudmlkaWFcIiwgXCJydW50aW1lc1wiOiB7XCJudmlkaWFcIjoge1wicGF0aFwiOiBcIm52aWRpYS1jb250YWluZXItcnVudGltZVwiLCBcInJ1bnRpbWVBcmdzXCI6IFtdfX19J1xuICAgIDogJ3tcImRhdGEtcm9vdFwiOiBcIi92YXIvbGliL2RvY2tlci1kYXRhXCJ9JztcblxuICB1ZC5hZGRDb21tYW5kcyhcbiAgICAnZWNobyBFQ1NfRU5BQkxFX0dQVV9TVVBQT1JUPXRydWUgPj4gL2V0Yy9lY3MvZWNzLmNvbmZpZycsXG4gICAgJ3N5c3RlbWN0bCBzdG9wIGVjcycsXG4gICAgJ3N5c3RlbWN0bCBzdG9wIGRvY2tlcicsXG4gICAgJ21rZnMueGZzIC9kZXYveHZkY3onLFxuICAgICdta2RpciAtcCAvdmFyL2xpYi9kb2NrZXItZGF0YScsXG4gICAgJ21vdW50IC9kZXYveHZkY3ogL3Zhci9saWIvZG9ja2VyLWRhdGEnLFxuICAgICdlY2hvIFwiL2Rldi94dmRjeiAvdmFyL2xpYi9kb2NrZXItZGF0YSB4ZnMgZGVmYXVsdHMsbm9mYWlsIDAgMlwiID4+IC9ldGMvZnN0YWInLFxuICAgICdta2RpciAtcCAvZXRjL2RvY2tlcicsXG4gICAgYGVjaG8gJyR7ZGFlbW9uSnNvbn0nID4gL2V0Yy9kb2NrZXIvZGFlbW9uLmpzb25gLFxuICAgICdzeXN0ZW1jdGwgc3RhcnQgZG9ja2VyJyxcbiAgICAnc3lzdGVtY3RsIHN0YXJ0IC0tbm8tYmxvY2sgZWNzJyxcbiAgKTtcbiAgcmV0dXJuIHVkO1xufVxuIl19