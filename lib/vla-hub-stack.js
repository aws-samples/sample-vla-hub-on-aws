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
const MODEL_VERSION_CONFIGS = {
    gr00t: GR00T_VERSION_CONFIGS,
    pi: PI_VERSION_CONFIGS,
    openvla: OPENVLA_VERSION_CONFIGS,
    smolvla: SMOLVLA_VERSION_CONFIGS,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmxhLWh1Yi1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInZsYS1odWItc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyw4RUFBZ0U7QUFDaEUseUVBQTJEO0FBQzNELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFFM0MscUNBQTBDO0FBQzFDLHFEQUF1RDtBQUV2RCxnRkFBZ0Y7QUFFaEY7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxNQUFNLHNCQUFzQixHQUE2QjtJQUN2RCxLQUFLLEVBQUU7UUFDTCxZQUFZLEVBQUcsb0NBQW9DO1FBQ25ELFlBQVksRUFBRywyQ0FBMkM7UUFDMUQsV0FBVyxFQUFJLG1DQUFtQztRQUNsRCxXQUFXLEVBQUksd0NBQXdDO0tBQ3hEO0lBQ0QsRUFBRSxFQUFFO1FBQ0YsWUFBWSxFQUFHLHNDQUFzQztRQUNyRCxXQUFXLEVBQUkscUNBQXFDO1FBQ3BELFlBQVksRUFBRyx5Q0FBeUM7UUFDeEQsV0FBVyxFQUFJLHNDQUFzQztLQUN0RDtJQUNELE9BQU8sRUFBRTtRQUNQLFlBQVksRUFBRyx5REFBeUQ7UUFDeEUsV0FBVyxFQUFJLDBDQUEwQztRQUN6RCxZQUFZLEVBQUcsNkJBQTZCO1FBQzVDLFdBQVcsRUFBSSw2QkFBNkI7S0FDN0M7SUFDRCxPQUFPLEVBQUU7UUFDUCxpREFBaUQ7UUFDakQsV0FBVyxFQUFJLDJDQUEyQztRQUMxRCxXQUFXLEVBQUksNkJBQTZCO1FBQzVDLFlBQVksRUFBRywyQkFBMkI7UUFDMUMsWUFBWSxFQUFHLGlCQUFpQjtLQUNqQztDQUNGLENBQUM7QUFvQkYsTUFBTSxvQkFBb0IsR0FBc0M7SUFDOUQsS0FBSyxFQUFFO1FBQ0wsV0FBVyxFQUFFLGdCQUFnQjtRQUM3QixnQkFBZ0IsRUFBRSxLQUFL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TyxFQUFFO1NBQ2xGLENBQUMsQ0FBQztRQUNILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLFlBQVksRUFBRTtZQUM3QyxLQUFLLEVBQUUsVUFBVSxDQUFDLGdCQUFnQjtZQUNsQyxXQUFXLEVBQUUsZ0RBQWdELE9BQU8sSUFBSSxPQUFPLEVBQUU7U0FDbEYsQ0FBQyxDQUFDO1FBRUgsK0ZBQStGO1FBQy9GLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLGlCQUFpQixFQUFFO1lBQ3hELGFBQWEsRUFBRSxZQUFZLE9BQU8sSUFBSSxXQUFXLENBQUMsV0FBVyxFQUFFLGdCQUFnQjtZQUMvRSxXQUFXLEVBQUUsR0FBRyxHQUFHLENBQUMsbUJBQW1CLElBQUksUUFBUSxFQUFFO1NBQ3RELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBhRCxrQ0FvYUM7QUFFRCxpRkFBaUY7QUFFakYsU0FBUyxhQUFhLENBQUMsZ0JBQXlCO0lBQzlDLE1BQU0sRUFBRSxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7SUFFbkMsTUFBTSxVQUFVLEdBQUcsZ0JBQWdCO1FBQ2pDLENBQUMsQ0FBQyxxSkFBcUo7UUFDdkosQ0FBQyxDQUFDLHVDQUF1QyxDQUFDO0lBRTVDLEVBQUUsQ0FBQyxXQUFXLENBQ1oseURBQXlELEVBQ3pELG9CQUFvQixFQUNwQix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLCtCQUErQixFQUMvQix1Q0FBdUMsRUFDdkMsOEVBQThFLEVBQzlFLHNCQUFzQixFQUN0QixTQUFTLFVBQVUsNkJBQTZCLEVBQ2hELHdCQUF3QixFQUN4QixnQ0FBZ0MsQ0FDakMsQ0FBQztJQUNGLE9BQU8sRUFBRSxDQUFDO0FBQ1osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlZnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVmcyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBhdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXV0b3NjYWxpbmcnO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBzc20gZnJvbSAnYXdzLWNkay1saWIvYXdzLXNzbSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgQXpTZWxlY3RvckNvbnN0cnVjdCB9IGZyb20gJy4vYXotc2VsZWN0b3IuanMnO1xuXG4vLyDilIDilIAgUGVyLW1vZGVsIHN0YXRpYyBjb25maWd1cmF0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIFNpbmdsZS1HUFUgaW5zdGFuY2UgdHlwZSBmYWxsYmFjayBvcmRlcnMgcGVyIG1vZGVsLlxuICpcbiAqIEdSMDBUOiByZXF1aXJlcyBGbGFzaEF0dGVudGlvbiDihpIgQW1wZXJlIEdQVSBvciBuZXdlciAoU004MCspLlxuICogICBnNjogTlZJRElBIEw0IChBZGEgTG92ZWxhY2UsIFNNODkpIOKchSBwcmVmZXJyZWRcbiAqICAgZzU6IE5WSURJQSBBMTBHIChBbXBlcmUsIFNNODYpICAgICDinIUgYWx0ZXJuYXRpdmVcbiAqICAgTk9URTogZzRkbiAoVDQsIFNNNzUpIGFuZCBwMyAoVjEwMCwgU003MCkgYXJlIE5PVCBzdXBwb3J0ZWQuXG4gKlxuICogUEk6IHVzZXMgSkFYIOKAlCBGbGFzaEF0dGVudGlvbiBpcyBOT1QgcmVxdWlyZWQuXG4gKiAgIGc1OiBOVklESUEgQTEwRyAoQW1wZXJlLCBTTTg2KSDinIUgcHJlZmVycmVkICgyNCBHQiBWUkFNKVxuICogICBnNjogTlZJRElBIEw0IChBZGEgTG92ZWxhY2UsIFNNODkpIOKchSBhbHRlcm5hdGl2ZVxuICovXG5jb25zdCBERUZBVUxUX0lOU1RBTkNFX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7XG4gIGdyMDB0OiBbXG4gICAgJ2c2LjJ4bGFyZ2UnLCAgLy8gTDQgw5cgMSwgOCB2Q1BVLCAzMiBHQiDigJQgcHJlZmVycmVkXG4gICAgJ2c1LjJ4bGFyZ2UnLCAgLy8gQTEwRyDDlyAxLCA4IHZDUFUsIDMyIEdCIOKAlCBnNiBhbHRlcm5hdGl2ZVxuICAgICdnNi54bGFyZ2UnLCAgIC8vIEw0IMOXIDEsIDQgdkNQVSwgMTYgR0Ig4oCUIGZhbGxiYWNrXG4gICAgJ2c1LnhsYXJnZScsICAgLy8gQTEwRyDDlyAxLCA0IHZDUFUsIDE2IEdCIOKAlCBsYXN0IHJlc29ydFxuICBdLFxuICBwaTogW1xuICAgICdnNS4yeGxhcmdlJywgIC8vIEExMEcgw5cgMSwgOCB2Q1BVLCAzMiBHQiDigJQgcHJlZmVycmVkXG4gICAgJ2c1LnhsYXJnZScsICAgLy8gQTEwRyDDlyAxLCA0IHZDUFUsIDE2IEdCIOKAlCBmYWxsYmFja1xuICAgICdnNi4yeGxhcmdlJywgIC8vIEw0IMOXIDEsIDggdkNQVSwgMzIgR0Ig4oCUIGc1IGFsdGVybmF0aXZlXG4gICAgJ2c2LnhsYXJnZScsICAgLy8gTDQgw5cgMSwgNCB2Q1BVLCAxNiBHQiDigJQgbGFzdCByZXNvcnRcbiAgXSxcbiAgb3BlbnZsYTogW1xuICAgICdnNS4yeGxhcmdlJywgIC8vIEExMEcgw5cgMSwgMjQgR0IgVlJBTSDigJQgN0IgQkYxNiAofjE0IEdCKSDsoIHtlakgKHByZWZlcnJlZClcbiAgICAnZzUueGxhcmdlJywgICAvLyBBMTBHIMOXIDEsIDI0IEdCIFZSQU0g4oCUIGNhcGFjaXR5IOu2gOyhsSDsi5wg64yA7JWIXG4gICAgJ2c2LjJ4bGFyZ2UnLCAgLy8gTDQgw5cgMSwgMjQgR0IgVlJBTSDigJQgZzUg64yA7JWIXG4gICAgJ2c2LnhsYXJnZScsICAgLy8gTDQgw5cgMSwgMjQgR0IgVlJBTSDigJQg7LWc7ZuEIOyImOuLqFxuICBdLFxuICBzbW9sdmxhOiBbXG4gICAgLy8gU21vbFZMQSA0NTBNOiBWUkFNIH4yIEdC66eMIO2VhOyalCDihpIgeGxhcmdlKDI0R0IpIOy2qeu2hFxuICAgICdnNS54bGFyZ2UnLCAgIC8vIEExMEcgw5cgMSwgMjQgR0IgVlJBTSDigJQgcHJlZmVycmVkICjqsIDsnqUg7KCA66C0KVxuICAgICdnNi54bGFyZ2UnLCAgIC8vIEw0IMOXIDEsIDI0IEdCIFZSQU0g4oCUIGc1IOuMgOyViFxuICAgICdnNS4yeGxhcmdlJywgIC8vIEExMEcgw5cgMSDigJQgY2FwYWNpdHkg67aA7KGxIOyLnFxuICAgICdnNi4yeGxhcmdlJywgIC8vIEw0IMOXIDEg4oCUIOy1nO2bhCDsiJjri6hcbiAgXSxcbn07XG5cbi8qKiBNb2RlbC1sZXZlbCBzdGF0aWMgY29uZmlnICh2ZXJzaW9uLWluZGVwZW5kZW50KS4gKi9cbmludGVyZmFjZSBNb2RlbFN0YXRpY0NvbmZpZyB7XG4gIGVjclJlcG9OYW1lOiBzdHJpbmc7XG4gIC8vIHRydWUgZm9yIHBpIChKQVgpOiBkYWVtb24uanNvbiBtdXN0IHNldCBudmlkaWEgYXMgZGVmYXVsdCBydW50aW1lIHNvIEVDUyByZWdpc3RlcnMgZWNzLmNhcGFiaWxpdHkubnZpZGlhLWdwdVxuICAvLyBmYWxzZSBmb3IgZ3IwMHQgKFB5VG9yY2gpOiBFQ1MgR1BVIEFNSSBhbHJlYWR5IGluY2x1ZGVzIG52aWRpYSBydW50aW1lOyBubyBleHBsaWNpdCBvdmVycmlkZSBuZWVkZWRcbiAgdXNlTnZpZGlhUnVudGltZTogYm9vbGVhbjtcbn1cblxuLyoqIFBlci12ZXJzaW9uIGNvbmZpZyB0aGF0IHZhcmllcyBhY3Jvc3MgbW9kZWwgdmVyc2lvbnMuICovXG5pbnRlcmZhY2UgTW9kZWxWZXJzaW9uQ29uZmlnIHtcbiAgY2x1c3Rlck5hbWU6IHN0cmluZztcbiAgY2FwYWNpdHlQcm92aWRlck5hbWU6IHN0cmluZztcbiAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IG51bWJlcjtcbiAgY29udGFpbmVyRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAvLyB0cnVlIOKGkiBhdHRhY2ggc2hhcmVkIEVGUyAvbW9kZWxzIHZvbHVtZSAobW9kZWwgd2VpZ2h0cyBzdG9yZWQgb24gRUZTLCBub3QgYmFrZWQgaW4gRG9ja2VyIGltYWdlKVxuICB1c2VFZnNNb2RlbHM/OiBib29sZWFuO1xufVxuXG5jb25zdCBNT0RFTF9TVEFUSUNfQ09ORklHUzogUmVjb3JkPHN0cmluZywgTW9kZWxTdGF0aWNDb25maWc+ID0ge1xuICBncjAwdDoge1xuICAgIGVjclJlcG9OYW1lOiAnZ3IwMHQtcmVhbHRpbWUnLFxuICAgIHVzZU52aWRpYVJ1bnRpbWU6IGZhbHNlLFxuICB9LFxuICBwaToge1xuICAgIGVjclJlcG9OYW1lOiAndmxhLXBpLXJlYWx0aW1lJyxcbiAgICB1c2VOdmlkaWFSdW50aW1lOiB0cnVlLFxuICB9LFxuICBvcGVudmxhOiB7XG4gICAgZWNyUmVwb05hbWU6ICd2bGEtb3BlbnZsYS1yZWFsdGltZScsXG4gICAgdXNlTnZpZGlhUnVudGltZTogZmFsc2UsXG4gIH0sXG4gIHNtb2x2bGE6IHtcbiAgICBlY3JSZXBvTmFtZTogJ3ZsYS1zbW9sdmxhLXJlYWx0aW1lJyxcbiAgICB1c2VOdmlkaWFSdW50aW1lOiBmYWxzZSxcbiAgfSxcbn07XG5cbi8vIEdSMDBUOiBOMSBzZXJpZXMg4oCUIGFsbCByZXF1aXJlIEFtcGVyZSsgKEZsYXNoQXR0ZW50aW9uKS5cbi8vIEhGIG1vZGVsIElEczogaHR0cHM6Ly9odWdnaW5nZmFjZS5jby9udmlkaWFcbmNvbnN0IEdSMDBUX1ZFUlNJT05fQ09ORklHUzogUmVjb3JkPHN0cmluZywgTW9kZWxWZXJzaW9uQ29uZmlnPiA9IHtcbiAgJ04xJzoge1xuICAgIGNsdXN0ZXJOYW1lOiAnZ3IwMHQtcmVhbHRpbWUtbjEnLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAnZ3IwMHQtZ3B1LWNwLW4xJyxcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMTYzODQsICAvLyBOMS0zQjogfjE0IEdCIG1vZGVsOyAxNiBHQiByZXNlcnZhdGlvbiBvbiBnNS9nNi4yeGxhcmdlXG4gICAgY29udGFpbmVyRW52OiB7XG4gICAgICBIRl9NT0RFTF9JRDogICAgJ252aWRpYS9HUjAwVC1OMS0zQicsXG4gICAgICBFTUJPRElNRU5UX1RBRzogJ0dSMScsXG4gICAgfSxcbiAgfSxcbiAgJ04xLjUnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICdncjAwdC1yZWFsdGltZS1uMS01JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ2dyMDB0LWdwdS1jcC1uMS01JyxcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMjA0ODAsICAvLyBOMS41LTdCOiB+MTYgR0IgbW9kZWw7IDIwIEdCIHJlc2VydmF0aW9uIG9uIGc1L2c2LjJ4bGFyZ2UgKDMyIEdCKVxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgSEZfTU9ERUxfSUQ6ICAgICdudmlkaWEvR1IwMFQtTjEuNS03QicsXG4gICAgICBFTUJPRElNRU5UX1RBRzogJ0dSMScsXG4gICAgfSxcbiAgfSxcbiAgJ04xLjYnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICdncjAwdC1yZWFsdGltZS1uMS02JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ2dyMDB0LWdwdS1jcC1uMS02JyxcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMjA0ODAsICAvLyBOMS42LTNCOiB+MTIgR0IgbW9kZWw7IDIwIEdCIHJlc2VydmF0aW9uIG9uIGc1L2c2LjJ4bGFyZ2UgKDMyIEdCKVxuICAgIHVzZUVmc01vZGVsczogdHJ1ZSxcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIEhGX01PREVMX0lEOiAgICAnbnZpZGlhL0dSMDBULU4xLjYtM0InLFxuICAgICAgRU1CT0RJTUVOVF9UQUc6ICdHUjEnLFxuICAgICAgSEZfSE9NRTogICAgICAgICcvbW9kZWxzJyxcbiAgICAgIEhGX0hVQl9PRkZMSU5FOiAnMScsXG4gICAgfSxcbiAgfSxcbiAgJ04xLjcnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICdncjAwdC1yZWFsdGltZS1uMS03JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ2dyMDB0LWdwdS1jcC1uMS03JyxcbiAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMjA0ODAsICAvLyBOMS43LTNCIChDb3Ntb3MtUmVhc29uMi0yQiBiYWNrYm9uZSk6IH4xMiBHQjsgMjAgR0IgcmVzZXJ2YXRpb24gb24gZzYuMnhsYXJnZSAoMzIgR0IpXG4gICAgdXNlRWZzTW9kZWxzOiB0cnVlLFxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgSEZfTU9ERUxfSUQ6ICAgICAgICAgICdudmlkaWEvR1IwMFQtTjEuNy1MSUJFUk8nLFxuICAgICAgRU1CT0RJTUVOVF9UQUc6ICAgICAgICdMSUJFUk9fUEFOREEnLFxuICAgICAgSEZfSE9NRTogICAgICAgICAgICAgICcvbW9kZWxzJyxcbiAgICAgIEhGX0hVQl9PRkZMSU5FOiAgICAgICAnMScsXG4gICAgICAvLyB0cmFuc2Zvcm1lcnMgNC41Ny54IF9wYXRjaF9taXN0cmFsX3JlZ2V4KCkgY2FsbHMgSEYgQVBJIGV2ZW4gd2hlbiBIRl9IVUJfT0ZGTElORT0xXG4gICAgICBUUkFOU0ZPUk1FUlNfT0ZGTElORTogJzEnLFxuICAgIH0sXG4gIH0sXG59O1xuXG4vLyDPgCAocGkpOiBKQVgtYmFzZWQg4oCUIG5vIEZsYXNoQXR0ZW50aW9uIHJlcXVpcmVtZW50LlxuLy8gVmVyc2lvbnM6IDAuNSwgMC42LCAwLjdcbmNvbnN0IFBJX1ZFUlNJT05fQ09ORklHUzogUmVjb3JkPHN0cmluZywgTW9kZWxWZXJzaW9uQ29uZmlnPiA9IHtcbiAgJzAuNSc6IHtcbiAgICBjbHVzdGVyTmFtZTogJ3ZsYS1waS1yZWFsdGltZS0wLTUnLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAncGktZ3B1LWNwLTAtNScsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDEyMjg4LCAgLy8gcGkwLjU6IH4xMCBHQiBpbiBKQVg7IDEyIEdCIG9uIGc1LnhsYXJnZSAofjE1LjggR0IgYXZhaWxhYmxlKVxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgTU9ERUxfQ09ORklHOiAgICAgICAgICdwaTA1X2xpYmVybycsXG4gICAgICBNT0RFTF9DSEVDS1BPSU5UX0RJUjogJy9vcHQvcGktY2FjaGUvY2hlY2twb2ludHMvcGkwNV9saWJlcm8nLFxuICAgIH0sXG4gIH0sXG4gICcwLjYnOiB7XG4gICAgY2x1c3Rlck5hbWU6ICd2bGEtcGktcmVhbHRpbWUtMC02JyxcbiAgICBjYXBhY2l0eVByb3ZpZGVyTmFtZTogJ3BpLWdwdS1jcC0wLTYnLFxuICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiAxNDMzNiwgIC8vIHBpMC42OiB+MTIgR0IgZXN0aW1hdGU7IDE0IEdCIHJlc2VydmF0aW9uXG4gICAgY29udGFpbmVyRW52OiB7XG4gICAgICBNT0RFTF9DT05GSUc6ICAgICAgICAgJ3BpMDZfbGliZXJvJyxcbiAgICAgIE1PREVMX0NIRUNLUE9JTlRfRElSOiAnL29wdC9waS1jYWNoZS9jaGVja3BvaW50cy9waTA2X2xpYmVybycsXG4gICAgfSxcbiAgfSxcbiAgJzAuNyc6IHtcbiAgICBjbHVzdGVyTmFtZTogJ3ZsYS1waS1yZWFsdGltZS0wLTcnLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAncGktZ3B1LWNwLTAtNycsXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDE2Mzg0LFxuICAgIGNvbnRhaW5lckVudjoge1xuICAgICAgTU9ERUxfQ09ORklHOiAgICAgICAgICdwaTA3X2xpYmVybycsXG4gICAgICBNT0RFTF9DSEVDS1BPSU5UX0RJUjogJy9vcHQvcGktY2FjaGUvY2hlY2twb2ludHMvcGkwN19saWJlcm8nLFxuICAgIH0sXG4gIH0sXG59O1xuXG4vLyBPcGVuVkxBOiBIdWdnaW5nRmFjZSBvcGVudmxhL29wZW52bGEtN2Ig4oCUIExMYU1BLTdCIGJhY2tib25lLCBQeVRvcmNoLlxuLy8gV2VpZ2h0cyBiYWtlZCBpbnRvIERvY2tlciBpbWFnZSAofjE0IEdCIEJGMTYpLiBObyBFRlMgcmVxdWlyZWQuXG5jb25zdCBPUEVOVkxBX1ZFUlNJT05fQ09ORklHUzogUmVjb3JkPHN0cmluZywgTW9kZWxWZXJzaW9uQ29uZmlnPiA9IHtcbiAgJzdiJzoge1xuICAgIGNsdXN0ZXJOYW1lOiAndmxhLW9wZW52bGEtcmVhbHRpbWUtN2InLFxuICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiAnb3BlbnZsYS1ncHUtY3AtN2InLFxuICAgIC8vIE9wZW5WTEEtN0IgQkYxNjogfjE0IEdCIFZSQU07IHJlc2VydmUgMjAgR0Igb24gZzUuMnhsYXJnZSAoMzIgR0IgdG90YWwgUkFNKVxuICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiAyMDQ4MCxcbiAgICBjb250YWluZXJFbnY6IHtcbiAgICAgIEhGX01PREVMX0lEOiAgICAgICAgICdvcGVudmxhL29wZW52bGEtN2InLFxuICAgICAgREVWSUNFOiAgICAgICAgICAgICAgJ2N1ZGE6MCcsXG4gICAgICBIRl9IVUJfT0ZGTElORTogICAgICAnMScsXG4gICAgICBUUkFOU0ZPUk1FUlNfT0ZGTElORTogJzEnLFxuICAgIH0sXG4gIH0sXG59O1xuXG4vLyBTbW9sVkxBOiBIdWdnaW5nRmFjZSBMZVJvYm90IGxlcm9ib3Qvc21vbHZsYV9iYXNlIOKAlCBTbW9sVkxNMi01MDBNICsgRmxvdyBNYXRjaGluZywgUHlUb3JjaC5cbi8vIFdlaWdodHMgYmFrZWQgaW50byBEb2NrZXIgaW1hZ2UgKH4xIEdCKS4gTm8gRUZTIHJlcXVpcmVkLiBBcGFjaGUgMi4wLlxuY29uc3QgU01PTFZMQV9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4gPSB7XG4gICc0NTBNJzoge1xuICAgIGNsdXN0ZXJOYW1lOiAndmxhLXNtb2x2bGEtcmVhbHRpbWUtNDUwbScsXG4gICAgY2FwYWNpdHlQcm92aWRlck5hbWU6ICdzbW9sdmxhLWdwdS1jcC00NTBtJyxcbiAgICAvLyBTbW9sVkxBIDQ1ME06IH4xIEdCIOuqqOuNuCArIExlUm9ib3QvUHlUb3JjaCBydW50aW1lICsgaGVhZHJvb21cbiAgICAvLyBnNS54bGFyZ2UgKDE1LjggR0Ig6rCA7JqpIFJBTSkg6riw7KSA7Jy866GcIDggR0IgcmVzZXJ2YXRpb24g7Jes7JygXG4gICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IDgxOTIsXG4gICAgY29udGFpbmVyRW52OiB7XG4gICAgICBIRl9NT0RFTF9JRDogICAgICAgICAgJ2xlcm9ib3Qvc21vbHZsYV9iYXNlJyxcbiAgICAgIERFVklDRTogICAgICAgICAgICAgICAnY3VkYTowJyxcbiAgICAgIEhGX0hVQl9PRkZMSU5FOiAgICAgICAnMScsXG4gICAgICBUUkFOU0ZPUk1FUlNfT0ZGTElORTogJzEnLFxuICAgIH0sXG4gIH0sXG59O1xuXG5jb25zdCBNT0RFTF9WRVJTSU9OX0NPTkZJR1M6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIE1vZGVsVmVyc2lvbkNvbmZpZz4+ID0ge1xuICBncjAwdDogR1IwMFRfVkVSU0lPTl9DT05GSUdTLFxuICBwaTogUElfVkVSU0lPTl9DT05GSUdTLFxuICBvcGVudmxhOiBPUEVOVkxBX1ZFUlNJT05fQ09ORklHUyxcbiAgc21vbHZsYTogU01PTFZMQV9WRVJTSU9OX0NPTkZJR1MsXG59O1xuXG5mdW5jdGlvbiByZXNvbHZlVmVyc2lvbkNvbmZpZyhtb2RlbElkOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZyk6IE1vZGVsVmVyc2lvbkNvbmZpZyB7XG4gIGNvbnN0IHZlcnNpb25NYXAgPSBNT0RFTF9WRVJTSU9OX0NPTkZJR1NbbW9kZWxJZF07XG4gIGlmICghdmVyc2lvbk1hcCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBtb2RlbElkICcke21vZGVsSWR9Jy4gQWRkIGFuIGVudHJ5IHRvIE1PREVMX1ZFUlNJT05fQ09ORklHUy5gKTtcbiAgfVxuICBjb25zdCBjZmcgPSB2ZXJzaW9uTWFwW3ZlcnNpb25dO1xuICBpZiAoIWNmZykge1xuICAgIGNvbnN0IHZhbGlkID0gT2JqZWN0LmtleXModmVyc2lvbk1hcCkuam9pbignLCAnKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gdmVyc2lvbiAnJHt2ZXJzaW9ufScgZm9yIG1vZGVsICcke21vZGVsSWR9Jy4gVmFsaWQgdmVyc2lvbnM6ICR7dmFsaWR9YCk7XG4gIH1cbiAgcmV0dXJuIGNmZztcbn1cblxuLy8g4pSA4pSAIEpTT04gY29uZmlnIHR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgaW50ZXJmYWNlIE1vZGVsQ2FwYWNpdHlDb25maWcge1xuICB0eXBlOiAnc3BvdCcgfCAnb24tZGVtYW5kJztcbiAgbWluOiBudW1iZXI7XG4gIG1heDogbnVtYmVyO1xuICBpbnN0YW5jZV90eXBlcz86IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1vZGVsQ29uZmlnIHtcbiAgaWQ6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBncnBjX3BvcnQ6IG51bWJlcjtcbiAgY2FwYWNpdHk6IE1vZGVsQ2FwYWNpdHlDb25maWc7XG4gIGVjckltYWdlVXJpPzogc3RyaW5nOyAgLy8gb3ZlcnJpZGU7IGRlZmF1bHRzIHRvIDxhY2NvdW50Pi5ka3IuZWNyLjxyZWdpb24+LmFtYXpvbmF3cy5jb20vPGVjclJlcG9OYW1lPjo8dmVyc2lvbj4tbGF0ZXN0XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVmxhSHViU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbW9kZWxzOiBNb2RlbENvbmZpZ1tdO1xufVxuXG4vLyDilIDilIAgVmxhSHViU3RhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBjbGFzcyBWbGFIdWJTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBWbGFIdWJTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyDilIDilIAgU2hhcmVkIFZQQyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnVnBjJywge1xuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHsgbmFtZTogJ3B1YmxpYycsICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsICAgICAgICAgICAgICBjaWRyTWFzazogMjQgfSxcbiAgICAgICAgeyBuYW1lOiAncHJpdmF0ZScsIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh2cGMsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtVlBDNycsIHJlYXNvbjogJ1NhbXBsZSBwcm9qZWN0OiBWUEMgRmxvdyBMb2dzIGFkZCBjb3N0IGFuZCBvcGVyYXRpb25hbCBvdmVyaGVhZCBub3Qgd2FycmFudGVkIGZvciBhIGRlbW8gZGVwbG95bWVudC4nIH0sXG4gICAgXSk7XG5cbiAgICAvLyDilIDilIAgU2hhcmVkIEVGUyAobW9kZWwgd2VpZ2h0cyDigJQgbW91bnRlZCBieSBFRlMtZW5hYmxlZCBtb2RlbCB2ZXJzaW9ucykg4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgZWZzU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRWZzU2cnLCB7XG4gICAgICB2cGMsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VGUyBncjAwdC1tb2RlbHMgLSBORlMgaW5ib3VuZCBmcm9tIEVDUyBHUFUgaW5zdGFuY2VzJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZWZzRmlsZVN5c3RlbSA9IG5ldyBlZnMuRmlsZVN5c3RlbSh0aGlzLCAnR3Jvb3RNb2RlbEVmcycsIHtcbiAgICAgIHZwYyxcbiAgICAgIGZpbGVTeXN0ZW1OYW1lOiAnZ3IwMHQtbW9kZWxzJyxcbiAgICAgIHRocm91Z2hwdXRNb2RlOiBlZnMuVGhyb3VnaHB1dE1vZGUuQlVSU1RJTkcsXG4gICAgICBwZXJmb3JtYW5jZU1vZGU6IGVmcy5QZXJmb3JtYW5jZU1vZGUuR0VORVJBTF9QVVJQT1NFLFxuICAgICAgc2VjdXJpdHlHcm91cDogZWZzU2VjdXJpdHlHcm91cCxcbiAgICAgIGVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICB9KTtcblxuICAgIGNvbnN0IGVmc0FjY2Vzc1BvaW50ID0gbmV3IGVmcy5BY2Nlc3NQb2ludCh0aGlzLCAnR3Jvb3RNb2RlbEFwJywge1xuICAgICAgZmlsZVN5c3RlbTogZWZzRmlsZVN5c3RlbSxcbiAgICAgIHBhdGg6ICcvbW9kZWxzJyxcbiAgICAgIGNyZWF0ZUFjbDogeyBvd25lclVpZDogJzAnLCBvd25lckdpZDogJzAnLCBwZXJtaXNzaW9uczogJzc1NScgfSxcbiAgICAgIHBvc2l4VXNlcjogeyB1aWQ6ICcwJywgZ2lkOiAnMCcgfSxcbiAgICB9KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhlZnNGaWxlU3lzdGVtLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUVGUzEnLCByZWFzb246ICdFRlMgYmFja3VwIG5vdCByZXF1aXJlZCBmb3IgbW9kZWwgd2VpZ2h0cyDigJQgd2VpZ2h0cyBhcmUgcmUtZG93bmxvYWRhYmxlIGZyb20gSHVnZ2luZ0ZhY2UuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgLy8g4pSA4pSAIFNoYXJlZCBpbnRlcm5hbCBOTEIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgbmxiID0gbmV3IGVsYnYyLk5ldHdvcmtMb2FkQmFsYW5jZXIodGhpcywgJ0dycGNObGInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogZmFsc2UsXG4gICAgfSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMobmxiLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUVMQjInLCByZWFzb246ICdTYW1wbGUgcHJvamVjdDogTkxCIGFjY2VzcyBsb2dnaW5nIGFkZHMgUzMgc3RvcmFnZSBjb3N0IG5vdCB3YXJyYW50ZWQgZm9yIGEgZGVtbyBkZXBsb3ltZW50LicgfSxcbiAgICBdKTtcblxuICAgIC8vIOKUgOKUgCBQZXItbW9kZWwgRUNTICsgQVNHIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGZvciAoY29uc3QgbW9kZWwgb2YgcHJvcHMubW9kZWxzKSB7XG4gICAgICB0aGlzLmFkZE1vZGVsU2VydmljZSh2cGMsIG5sYiwgbW9kZWwsIGVmc0ZpbGVTeXN0ZW0sIGVmc0FjY2Vzc1BvaW50LCBlZnNTZWN1cml0eUdyb3VwKTtcbiAgICB9XG5cbiAgICAvLyBTdGFjay1sZXZlbCBzdXBwcmVzc2lvbiBmb3IgQ0RLLWdlbmVyYXRlZCBEcmFpbkVDU0hvb2sgU2VydmljZVJvbGUgd2lsZGNhcmRzLlxuICAgIC8vIGNkay1uYWcgZ3JhbnVsYXIgcnVsZXMgcmVxdWlyZSBhcHBsaWVzVG8gYnV0IHRoZSBBU0cgcmVzb3VyY2UgQVJOIGNvbnRhaW5zIGEgQ0ZOXG4gICAgLy8gbG9naWNhbCBJRCB0b2tlbiB0aGF0IGNhbm5vdCBiZSBwcmVkaWN0ZWQgYXQgc3ludGggdGltZSDigJQgc3RhY2stbGV2ZWwgc3VwcHJlc3Npb24gaXMgdGhlXG4gICAgLy8gb25seSByZWxpYWJsZSB3YXkgdG8gc2lsZW5jZSB0aGVzZSBDREstaW50ZXJuYWwgZmluZGluZ3MuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ0NESy1nZW5lcmF0ZWQgRUNTIGRyYWluIGxpZmVjeWNsZSBob29rIExhbWJkYSBTZXJ2aWNlUm9sZS4gQVNHIHJlc291cmNlIEFSTiB3aWxkY2FyZCAoYXV0b1NjYWxpbmdHcm91cDoqOmF1dG9TY2FsaW5nR3JvdXBOYW1lLzx0b2tlbj4pIGFuZCBlY3M6KiB3aWxkY2FyZHMgYXJlIHJlcXVpcmVkIGJ5IENES1xcJ3MgYnVpbHQtaW4gZHJhaW4gaG9vayBpbXBsZW1lbnRhdGlvbiBhbmQgY2Fubm90IGJlIHNjb3BlZCBmdXJ0aGVyLicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQ0RLLWdlbmVyYXRlZCBFQ1MgZHJhaW4gbGlmZWN5Y2xlIGhvb2sgTGFtYmRhIFNlcnZpY2VSb2xlLiBBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgdGhlIG1pbmltdW0gcmVxdWlyZWQgbWFuYWdlZCBwb2xpY3kgZm9yIExhbWJkYSBDbG91ZFdhdGNoIExvZ3MgYWNjZXNzLicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXG4gICAgICAgIHJlYXNvbjogJ0NESy1nZW5lcmF0ZWQgRUNTIGRyYWluIGxpZmVjeWNsZSBob29rIExhbWJkYS4gUnVudGltZSB2ZXJzaW9uIGlzIG1hbmFnZWQgYnkgQ0RLIGludGVybmFsbHkuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLVNOUzMnLFxuICAgICAgICByZWFzb246ICdDREstZ2VuZXJhdGVkIEVDUyBkcmFpbiBsaWZlY3ljbGUgaG9vayBTTlMgdG9waWMuIFNTTCBlbmZvcmNlbWVudCBub3QgYXBwbGljYWJsZSB0byBpbnRlcm5hbGx5LXRyaWdnZXJlZCBsaWZlY3ljbGUgbm90aWZpY2F0aW9ucy4nLFxuICAgICAgfSxcbiAgICBdKTtcblxuICAgIC8vIOKUgOKUgCBPdXRwdXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdObGJEbnNOYW1lJywge1xuICAgICAgdmFsdWU6IG5sYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTaGFyZWQgaW50ZXJuYWwgTkxCIEROUyBuYW1lIChWUEMtb25seSkuIENvbm5lY3Qgb24gbW9kZWwtc3BlY2lmaWMgZ1JQQyBwb3J0cy4nLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdWcGNJZCcsIHtcbiAgICAgIHZhbHVlOiB2cGMudnBjSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ZQQyBJRCAtIHBsYWNlIGdSUEMgY2xpZW50IEVDMiBpbiB0aGlzIFZQQyB0byByZWFjaCB0aGUgTkxCJyxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUHJpdmF0ZVN1Ym5ldElkcycsIHtcbiAgICAgIHZhbHVlOiB2cGMucHJpdmF0ZVN1Ym5ldHMubWFwKHMgPT4gcy5zdWJuZXRJZCkuam9pbignLCcpLFxuICAgICAgZGVzY3JpcHRpb246ICdQcml2YXRlIHN1Ym5ldCBJRHMgLSBwbGFjZSBnUlBDIGNsaWVudCBFQzIgaW4gb25lIG9mIHRoZXNlIHN1Ym5ldHMnLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIFNTTSBQYXJhbWV0ZXJzIChjb25zdW1lZCBieSBlbmFibGVtZW50LXBhY2sgZGVwbG95LnB5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCAnU3NtTmxiRG5zJywge1xuICAgICAgcGFyYW1ldGVyTmFtZTogJy92bGEtaHViL25sYi1kbnMnLFxuICAgICAgc3RyaW5nVmFsdWU6IG5sYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgIH0pO1xuICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsICdTc21WcGNJZCcsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6ICcvdmxhLWh1Yi92cGMtaWQnLFxuICAgICAgc3RyaW5nVmFsdWU6IHZwYy52cGNJZCxcbiAgICB9KTtcbiAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCAnU3NtUHJpdmF0ZVN1Ym5ldElkcycsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6ICcvdmxhLWh1Yi9wcml2YXRlLXN1Ym5ldC1pZHMnLFxuICAgICAgc3RyaW5nVmFsdWU6IHZwYy5wcml2YXRlU3VibmV0cy5tYXAocyA9PiBzLnN1Ym5ldElkKS5qb2luKCcsJyksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZE1vZGVsU2VydmljZShcbiAgICB2cGM6IGVjMi5WcGMsXG4gICAgbmxiOiBlbGJ2Mi5OZXR3b3JrTG9hZEJhbGFuY2VyLFxuICAgIG1vZGVsOiBNb2RlbENvbmZpZyxcbiAgICBlZnNGaWxlU3lzdGVtOiBlZnMuRmlsZVN5c3RlbSxcbiAgICBlZnNBY2Nlc3NQb2ludDogZWZzLkFjY2Vzc1BvaW50LFxuICAgIGVmc1NlY3VyaXR5R3JvdXA6IGVjMi5TZWN1cml0eUdyb3VwLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCB7IGlkOiBtb2RlbElkLCB2ZXJzaW9uLCBncnBjX3BvcnQ6IGdycGNQb3J0LCBjYXBhY2l0eSB9ID0gbW9kZWw7XG4gICAgY29uc3Qgc3RhdGljQ2ZnICA9IE1PREVMX1NUQVRJQ19DT05GSUdTW21vZGVsSWRdO1xuICAgIGlmICghc3RhdGljQ2ZnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gbW9kZWxJZCAnJHttb2RlbElkfScuIEFkZCBhbiBlbnRyeSB0byBNT0RFTF9TVEFUSUNfQ09ORklHUy5gKTtcbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbkNmZyA9IHJlc29sdmVWZXJzaW9uQ29uZmlnKG1vZGVsSWQsIHZlcnNpb24pO1xuXG4gICAgLy8gU2FuaXRpemUgdmVyc2lvbiBmb3IgdXNlIGluIENsb3VkRm9ybWF0aW9uIGxvZ2ljYWwgSURzIChkb3RzIOKGkiBkYXNoLCBhbHBoYW51bWVyaWMgb25seSkuXG4gICAgY29uc3QgdmVyc2lvblNhZmUgPSB2ZXJzaW9uLnJlcGxhY2UoL1teYS16QS1aMC05XS9nLCAnLScpO1xuICAgIGNvbnN0IGluc3RhbmNlVHlwZXMgPSBjYXBhY2l0eS5pbnN0YW5jZV90eXBlcyA/PyBERUZBVUxUX0lOU1RBTkNFX1RZUEVTW21vZGVsSWRdID8/IFsnZzYuMnhsYXJnZSddO1xuICAgIC8vIEVDUiBpbWFnZSB0YWcgaW5jbHVkZXMgdmVyc2lvbiBzbyBlYWNoIHZlcnNpb24gbWFwcyB0byBhIHNlcGFyYXRlIGltYWdlIHRhZy5cbiAgICBjb25zdCBlY3JJbWFnZVVyaSAgID0gbW9kZWwuZWNySW1hZ2VVcmlcbiAgICAgID8/IGAke3RoaXMuYWNjb3VudH0uZGtyLmVjci4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7c3RhdGljQ2ZnLmVjclJlcG9OYW1lfToke3ZlcnNpb259LWxhdGVzdGA7XG5cbiAgICAvLyBDb25zdHJ1Y3QgcHJlZml4IGZvciBDRk4gbG9naWNhbCBJRHM6IGUuZy4gXCJHcjAwdC1OMS02XCIgb3IgXCJQaS0wLTVcIlxuICAgIGNvbnN0IGlkUGFydCAgICAgID0gbW9kZWxJZC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIG1vZGVsSWQuc2xpY2UoMSk7XG4gICAgY29uc3QgcHJlZml4ICAgICAgPSBgJHtpZFBhcnR9LSR7dmVyc2lvblNhZmV9YDtcblxuICAgIC8vIOKUgOKUgCBBelNlbGVjdG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IGVjc0dwdUFtaSAgPSBlY3MuRWNzT3B0aW1pemVkSW1hZ2UuYW1hem9uTGludXgyKGVjcy5BbWlIYXJkd2FyZVR5cGUuR1BVKTtcbiAgICBjb25zdCBwcm9iZUFtaUlkID0gZWNzR3B1QW1pLmdldEltYWdlKHRoaXMpLmltYWdlSWQ7XG5cbiAgICBjb25zdCBhelNlbGVjdG9yID0gbmV3IEF6U2VsZWN0b3JDb25zdHJ1Y3QodGhpcywgYCR7cHJlZml4fUF6U2VsZWN0b3JgLCB7XG4gICAgICBpbnN0YW5jZVR5cGVzLFxuICAgICAgYW1pSWQ6IHByb2JlQW1pSWQsXG4gICAgICBzdWJuZXRJZHM6IHZwYy5wcml2YXRlU3VibmV0cy5tYXAocyA9PiBzLnN1Ym5ldElkKSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBFQ1MgQ2x1c3RlciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsIGAke3ByZWZpeH1DbHVzdGVyYCwge1xuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWU6IHZlcnNpb25DZmcuY2x1c3Rlck5hbWUsXG4gICAgICBjb250YWluZXJJbnNpZ2h0c1YyOiBlY3MuQ29udGFpbmVySW5zaWdodHMuRU5BQkxFRCxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBHUFUgQVNHIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IHNlbGVjdGVkU3VibmV0ID0gZWMyLlN1Ym5ldC5mcm9tU3VibmV0QXR0cmlidXRlcyh0aGlzLCBgJHtwcmVmaXh9QXpTZWxlY3RlZFN1Ym5ldGAsIHtcbiAgICAgIHN1Ym5ldElkOiBhelNlbGVjdG9yLnN1Ym5ldElkLFxuICAgICAgYXZhaWxhYmlsaXR5Wm9uZTogYXpTZWxlY3Rvci5hdmFpbGFiaWxpdHlab25lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXNnID0gbmV3IGF1dG9zY2FsaW5nLkF1dG9TY2FsaW5nR3JvdXAodGhpcywgYCR7cHJlZml4fUdwdUFzZ2AsIHtcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6ICAgICAgIHsgc3VibmV0czogW3NlbGVjdGVkU3VibmV0XSB9LFxuICAgICAgaW5zdGFuY2VUeXBlOiAgICAgbmV3IGVjMi5JbnN0YW5jZVR5cGUoYXpTZWxlY3Rvci5yZXNvbHZlZEluc3RhbmNlVHlwZSksXG4gICAgICBtYWNoaW5lSW1hZ2U6ICAgICBlY3NHcHVBbWksXG4gICAgICBtaW5DYXBhY2l0eTogICAgICBjYXBhY2l0eS5taW4sXG4gICAgICBtYXhDYXBhY2l0eTogICAgICBjYXBhY2l0eS5tYXgsXG4gICAgICBkZXNpcmVkQ2FwYWNpdHk6ICBjYXBhY2l0eS5taW4gPiAwID8gY2FwYWNpdHkubWluIDogdW5kZWZpbmVkLFxuICAgICAgdXNlckRhdGE6ICAgICAgICAgYnVpbGRVc2VyRGF0YShzdGF0aWNDZmcudXNlTnZpZGlhUnVudGltZSksXG4gICAgICBibG9ja0RldmljZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGRldmljZU5hbWU6ICcvZGV2L3h2ZGEnLFxuICAgICAgICAgIHZvbHVtZTogYXV0b3NjYWxpbmcuQmxvY2tEZXZpY2VWb2x1bWUuZWJzKDUwLCB7XG4gICAgICAgICAgICB2b2x1bWVUeXBlOiBhdXRvc2NhbGluZy5FYnNEZXZpY2VWb2x1bWVUeXBlLkdQMyxcbiAgICAgICAgICAgIGVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIC8vIERvY2tlciBkYXRhIHJvb3Qg4oCUIGZvcm1hdHRlZCBhbmQgbW91bnRlZCB2aWEgdXNlcmRhdGFcbiAgICAgICAgICBkZXZpY2VOYW1lOiAnL2Rldi94dmRjeicsXG4gICAgICAgICAgdm9sdW1lOiBhdXRvc2NhbGluZy5CbG9ja0RldmljZVZvbHVtZS5lYnMoMjAwLCB7XG4gICAgICAgICAgICB2b2x1bWVUeXBlOiBhdXRvc2NhbGluZy5FYnNEZXZpY2VWb2x1bWVUeXBlLkdQMyxcbiAgICAgICAgICAgIGVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoYXNnLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUFTMycsICByZWFzb246ICdTYW1wbGUgcHJvamVjdDogQVNHIHNjYWxpbmcgbm90aWZpY2F0aW9ucyBub3QgcmVxdWlyZWQuIFRoZSBHUFUgQVNHIHJ1bnMgZXhhY3RseSAxIHRhc2sgcGVyIGluc3RhbmNlOyBzY2FsZSBldmVudHMgdHJpZ2dlciBvbmx5IG9uIEVDUyBjYXBhY2l0eSBjaGFuZ2VzLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtRUMyMycsIHJlYXNvbjogJ2dSUEMgcG9ydCBpcyByZXN0cmljdGVkIHRvIHZwYy52cGNDaWRyQmxvY2sgb25seS4gVGhlIE5MQiBpcyBpbnRlcm5hbCAobm90IGludGVybmV0LWZhY2luZyk7IGFsbCBnUlBDIGNsaWVudHMgbXVzdCByZXNpZGUgaW4gdGhlIHNhbWUgVlBDLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIEVGUyBORlMgKHBvcnQgMjA0OSkg4oCUIEFTRyBpbnN0YW5jZXMg4oaSIEVGUyBtb3VudCB0YXJnZXRcbiAgICBpZiAodmVyc2lvbkNmZy51c2VFZnNNb2RlbHMpIHtcbiAgICAgIGVmc1NlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChhc2cuY29ubmVjdGlvbnMuc2VjdXJpdHlHcm91cHNbMF0uc2VjdXJpdHlHcm91cElkKSxcbiAgICAgICAgZWMyLlBvcnQudGNwKDIwNDkpLFxuICAgICAgICBgTkZTIGZyb20gJHtwcmVmaXh9IEdQVSBBU0dgLFxuICAgICAgKTtcbiAgICAgIGFzZy5jb25uZWN0aW9ucy5hbGxvd1RvKGVmc1NlY3VyaXR5R3JvdXAsIGVjMi5Qb3J0LnRjcCgyMDQ5KSwgYE5GUyB0byBFRlMgKCR7cHJlZml4fSlgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjYXBhY2l0eVByb3ZpZGVyID0gbmV3IGVjcy5Bc2dDYXBhY2l0eVByb3ZpZGVyKHRoaXMsIGAke3ByZWZpeH1HcHVDYXBhY2l0eVByb3ZpZGVyYCwge1xuICAgICAgYXV0b1NjYWxpbmdHcm91cDogYXNnLFxuICAgICAgZW5hYmxlTWFuYWdlZFNjYWxpbmc6IHRydWUsXG4gICAgICBlbmFibGVNYW5hZ2VkVGVybWluYXRpb25Qcm90ZWN0aW9uOiBmYWxzZSxcbiAgICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiB2ZXJzaW9uQ2ZnLmNhcGFjaXR5UHJvdmlkZXJOYW1lLFxuICAgIH0pO1xuICAgIGNsdXN0ZXIuYWRkQXNnQ2FwYWNpdHlQcm92aWRlcihjYXBhY2l0eVByb3ZpZGVyKTtcblxuICAgIC8vIOKUgOKUgCBUYXNrIERlZmluaXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgYCR7cHJlZml4fVRhc2tSb2xlYCwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICB0YXNrUm9sZS5hZGRUb1ByaW5jaXBhbFBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzc21tZXNzYWdlczpDcmVhdGVDb250cm9sQ2hhbm5lbCcsXG4gICAgICAgICdzc21tZXNzYWdlczpDcmVhdGVEYXRhQ2hhbm5lbCcsXG4gICAgICAgICdzc21tZXNzYWdlczpPcGVuQ29udHJvbENoYW5uZWwnLFxuICAgICAgICAnc3NtbWVzc2FnZXM6T3BlbkRhdGFDaGFubmVsJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh0YXNrUm9sZSwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnU1NNIFNlc3Npb24gTWFuYWdlciAoRUNTIEV4ZWMpIHJlcXVpcmVzIHNzbW1lc3NhZ2VzOkNyZWF0ZS9PcGVuQ29udHJvbENoYW5uZWwgYW5kIERhdGFDaGFubmVsIG9uIHJlc291cmNlICog4oCUIEFXUy1kZWZpbmVkIHNjb3BlLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgYCR7cHJlZml4fUxvZ0dyb3VwYCwge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2Vjcy8ke3ZlcnNpb25DZmcuY2x1c3Rlck5hbWV9YCxcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRhc2tEZWYgPSBuZXcgZWNzLkVjMlRhc2tEZWZpbml0aW9uKHRoaXMsIGAke3ByZWZpeH1UYXNrRGVmYCwge1xuICAgICAgbmV0d29ya01vZGU6IGVjcy5OZXR3b3JrTW9kZS5CUklER0UsXG4gICAgICB0YXNrUm9sZSxcbiAgICB9KTtcblxuICAgIHRhc2tEZWYuYWRkVG9FeGVjdXRpb25Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModGFza0RlZiwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1FQ1MyJywgcmVhc29uOiAnQ29udGFpbmVyIGVudmlyb25tZW50IHZhcmlhYmxlcyBhcmUgbm9uLXNlbnNpdGl2ZSBtb2RlbCBjb25maWcgaWRlbnRpZmllcnMsIG5vdCBzZWNyZXRzLiBJbmplY3RpbmcgdGhlbSB2aWEgU1NNL1NNIHdvdWxkIGFkZCB1bm5lY2Vzc2FyeSBjb21wbGV4aXR5IGZvciBhIHNhbXBsZSBwcm9qZWN0LicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4gcmVxdWlyZXMgcmVzb3VyY2UgKiBwZXIgRUNSIEFQSSBzcGVjaWZpY2F0aW9uLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIEVGUyB2b2x1bWUg4oCUIG1vZGVsIHdlaWdodHMgbGl2ZSBvbiBFRlMsIG5vdCBiYWtlZCBpbiBEb2NrZXIgaW1hZ2VcbiAgICBpZiAodmVyc2lvbkNmZy51c2VFZnNNb2RlbHMpIHtcbiAgICAgIHRhc2tEZWYuYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ2dyMDB0LW1vZGVscycsXG4gICAgICAgIGVmc1ZvbHVtZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBmaWxlU3lzdGVtSWQ6IGVmc0ZpbGVTeXN0ZW0uZmlsZVN5c3RlbUlkLFxuICAgICAgICAgIHRyYW5zaXRFbmNyeXB0aW9uOiAnRU5BQkxFRCcsXG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICAgICAgYWNjZXNzUG9pbnRJZDogZWZzQWNjZXNzUG9pbnQuYWNjZXNzUG9pbnRJZCxcbiAgICAgICAgICAgIGlhbTogJ0VOQUJMRUQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgLy8gRUZTIGVsYXN0aWNmaWxlc3lzdGVtIGFjY2VzcyBmb3IgdGhlIHRhc2sgZXhlY3V0aW9uIHJvbGVcbiAgICAgIHRhc2tEZWYuYWRkVG9UYXNrUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50TW91bnQnLFxuICAgICAgICAgICdlbGFzdGljZmlsZXN5c3RlbTpDbGllbnRXcml0ZScsXG4gICAgICAgICAgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudFJvb3RBY2Nlc3MnLFxuICAgICAgICAgICdlbGFzdGljZmlsZXN5c3RlbTpEZXNjcmliZU1vdW50VGFyZ2V0cycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2Vmc0ZpbGVTeXN0ZW0uZmlsZVN5c3RlbUFybl0sXG4gICAgICB9KSk7XG4gICAgfVxuXG4gICAgY29uc3QgY29udGFpbmVyID0gdGFza0RlZi5hZGRDb250YWluZXIoYCR7bW9kZWxJZH0tJHt2ZXJzaW9uU2FmZX1gLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21SZWdpc3RyeShlY3JJbWFnZVVyaSksXG4gICAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogdmVyc2lvbkNmZy5tZW1vcnlSZXNlcnZhdGlvbk1pQixcbiAgICAgIGdwdUNvdW50OiAxLFxuICAgICAgZW52aXJvbm1lbnQ6IHsgLi4udmVyc2lvbkNmZy5jb250YWluZXJFbnYsIEdSUENfUE9SVDogU3RyaW5nKGdycGNQb3J0KSB9LFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogbW9kZWxJZCxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIHBvcnRNYXBwaW5nczogW1xuICAgICAgICAvLyBGaXhlZCBwb3J0IG1hcHBpbmdzIChob3N0UG9ydCA9PSBjb250YWluZXJQb3J0KS5cbiAgICAgICAgLy8gU2FmZSBiZWNhdXNlIHdlIHJ1biBleGFjdGx5IDEgdGFzayBwZXIgaW5zdGFuY2UgKDEgR1BVIHBlciBob3N0KS5cbiAgICAgICAgeyBjb250YWluZXJQb3J0OiBncnBjUG9ydCwgaG9zdFBvcnQ6IGdycGNQb3J0ICAvKiBnUlBDIGluZmVyZW5jZSBzZXJ2ZXIgKi8gfSxcbiAgICAgICAgeyBjb250YWluZXJQb3J0OiA4MDgwLCAgICAgaG9zdFBvcnQ6IDgwODAgICAgICAvKiBIVFRQIGhlYWx0aCBzZXJ2ZXIgICAgKi8gfSxcbiAgICAgIF0sXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAvLyBzZXJ2ZS5weSBzdGFydHMgdGhlIEhUVFAgaGVhbHRoIHNlcnZlciBvbmx5IEFGVEVSIG1vZGVsIGxvYWRzLlxuICAgICAgICBjb21tYW5kOiAgICAgWydDTUQtU0hFTEwnLCAnL29wdC9tbC9jb2RlL2NoZWNrX2hlYWx0aC5zaCddLFxuICAgICAgICBpbnRlcnZhbDogICAgY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICB0aW1lb3V0OiAgICAgY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICByZXRyaWVzOiAgICAgMyxcbiAgICAgICAgc3RhcnRQZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwMCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKHZlcnNpb25DZmcudXNlRWZzTW9kZWxzKSB7XG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBjb250YWluZXJQYXRoOiAnL21vZGVscycsXG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ2dyMDB0LW1vZGVscycsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgCBFQ1MgU2VydmljZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBkZXNpcmVkQ291bnQgPSBjYXBhY2l0eS5taW47XG5cbiAgICBjb25zdCBzZXJ2aWNlID0gbmV3IGVjcy5FYzJTZXJ2aWNlKHRoaXMsIGAke3ByZWZpeH1TZXJ2aWNlYCwge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmLFxuICAgICAgZGVzaXJlZENvdW50LFxuICAgICAgY2FwYWNpdHlQcm92aWRlclN0cmF0ZWdpZXM6IFt7XG4gICAgICAgIGNhcGFjaXR5UHJvdmlkZXI6IGNhcGFjaXR5UHJvdmlkZXIuY2FwYWNpdHlQcm92aWRlck5hbWUsXG4gICAgICAgIHdlaWdodDogMSxcbiAgICAgIH1dLFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDAsXG4gICAgICBtYXhIZWFsdGh5UGVyY2VudDogMTAwLFxuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHRydWUsXG4gICAgICBoZWFsdGhDaGVja0dyYWNlUGVyaW9kOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzNjApLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIE5MQiBMaXN0ZW5lciArIFRhcmdldCBHcm91cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBOTEIgaXMgdHJhbnNwYXJlbnQgYXQgTDQg4oCUIGNsaWVudCBJUHMgcGFzcyB0aHJvdWdoIHRvIEVDMiBpbnN0YW5jZS5cbiAgICBhc2cuY29ubmVjdGlvbnMuYWxsb3dGcm9tKFxuICAgICAgZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSxcbiAgICAgIGVjMi5Qb3J0LnRjcChncnBjUG9ydCksXG4gICAgICBgZ1JQQyA6JHtncnBjUG9ydH0gZnJvbSBWUEMgKGludGVybmFsIE5MQilgLFxuICAgICk7XG4gICAgYXNnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShcbiAgICAgIGVjMi5QZWVyLmlwdjQodnBjLnZwY0NpZHJCbG9jayksXG4gICAgICBlYzIuUG9ydC50Y3AoODA4MCksXG4gICAgICAnTkxCIEhUVFAgaGVhbHRoIGNoZWNrIG9uIGZpeGVkIHBvcnQgODA4MCcsXG4gICAgKTtcblxuICAgIGNvbnN0IGxpc3RlbmVyID0gbmxiLmFkZExpc3RlbmVyKGAke3ByZWZpeH1HcnBjTGlzdGVuZXJgLCB7XG4gICAgICBwb3J0OiBncnBjUG9ydCxcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5Qcm90b2NvbC5UQ1AsXG4gICAgfSk7XG5cbiAgICBsaXN0ZW5lci5hZGRUYXJnZXRzKGAke3ByZWZpeH1HcnBjVGFyZ2V0YCwge1xuICAgICAgcG9ydDogZ3JwY1BvcnQsXG4gICAgICBwcm90b2NvbDogZWxidjIuUHJvdG9jb2wuVENQLFxuICAgICAgdGFyZ2V0czogW1xuICAgICAgICBzZXJ2aWNlLmxvYWRCYWxhbmNlclRhcmdldCh7IGNvbnRhaW5lck5hbWU6IGAke21vZGVsSWR9LSR7dmVyc2lvblNhZmV9YCwgY29udGFpbmVyUG9ydDogZ3JwY1BvcnQgfSksXG4gICAgICBdLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgLy8gSFRUUCBoZWFsdGggY2hlY2sgb24gcG9ydCA4MDgwIChzZXJ2ZS5weSBIVFRQIGhlYWx0aCBzZXJ2ZXIpLlxuICAgICAgICAvLyBSZXR1cm5zIDIwMCBvbmx5IGFmdGVyIG1vZGVsIGlzIGxvYWRlZC5cbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLlByb3RvY29sLkhUVFAsXG4gICAgICAgIHBvcnQ6ICc4MDgwJyxcbiAgICAgICAgcGF0aDogJy9oZWFsdGgnLFxuICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDEwLFxuICAgICAgfSxcbiAgICAgIGRlcmVnaXN0cmF0aW9uRGVsYXk6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICB9KTtcblxuICAgIC8vIE5MQiBTRzogYWxsb3cgaGVhbHRoIGNoZWNrIGFuZCB0cmFmZmljIGZvcndhcmRpbmdcbiAgICBubGIuY29ubmVjdGlvbnMuYWxsb3dUbyhhc2csIGVjMi5Qb3J0LnRjcCg4MDgwKSwgICAgYE5MQiB0byBFQzIgSFRUUCBoZWFsdGggY2hlY2sgKCR7bW9kZWxJZH0pYCk7XG4gICAgbmxiLmNvbm5lY3Rpb25zLmFsbG93VG8oYXNnLCBlYzIuUG9ydC50Y3AoZ3JwY1BvcnQpLCBgTkxCIHRvIEVDMiBnUlBDIDoke2dycGNQb3J0fSAoJHttb2RlbElkfSlgKTtcbiAgICBubGIuY29ubmVjdGlvbnMuYWxsb3dGcm9tKFxuICAgICAgZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSxcbiAgICAgIGVjMi5Qb3J0LnRjcChncnBjUG9ydCksXG4gICAgICBgZ1JQQyA6JHtncnBjUG9ydH0gY2xpZW50cyB3aXRoaW4gVlBDYCxcbiAgICApO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKG5sYiwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1FQzIzJywgcmVhc29uOiAnSW50ZXJuYWwgTkxCOiBnUlBDIHBvcnQgaXMgcmVzdHJpY3RlZCB0byB2cGMudnBjQ2lkckJsb2NrLiBObyBwdWJsaWMgaW50ZXJuZXQgYWNjZXNzIOKAlCBWUEMtbGV2ZWwgaXNvbGF0aW9uIGVuZm9yY2VkLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIOKUgOKUgCBFQ1MgU2VydmljZSBBdXRvIFNjYWxpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgLy8gR1BVIGluc3RhbmNlIHN0YXJ0dXAgKEVDMiBib290ICsgRUNTIGFnZW50ICsgbW9kZWwgbG9hZCkgdGFrZXMgfjEwIG1pbi5cbiAgICAvLyBTY2FsZS1pbiBjb29sZG93biBzZXQgdG8gMTUgbWluIHRvIHByZXZlbnQgZmxhcHBpbmcuXG4gICAgY29uc3Qgc2NhbGluZyA9IHNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiBjYXBhY2l0eS5taW4sXG4gICAgICBtYXhDYXBhY2l0eTogY2FwYWNpdHkubWF4LFxuICAgIH0pO1xuXG4gICAgc2NhbGluZy5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oYCR7cHJlZml4fUNwdVNjYWxpbmdgLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDcwLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICBzY2FsZUluQ29vbGRvd246ICBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgUGVyLW1vZGVsIE91dHB1dHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgYCR7cHJlZml4fUdycGNFbmRwb2ludGAsIHtcbiAgICAgIHZhbHVlOiBgJHtubGIubG9hZEJhbGFuY2VyRG5zTmFtZX06JHtncnBjUG9ydH1gLFxuICAgICAgZGVzY3JpcHRpb246IGBnUlBDIGluZmVyZW5jZSBlbmRwb2ludCBmb3IgJHttb2RlbElkfUAke3ZlcnNpb259IChpbnRlcm5hbCBOTEIgLSBWUEMtb25seSkuYCxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBgJHtwcmVmaXh9U2VsZWN0ZWRJbnN0YW5jZVR5cGVgLCB7XG4gICAgICB2YWx1ZTogYXpTZWxlY3Rvci5yZXNvbHZlZEluc3RhbmNlVHlwZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBgR1BVIGluc3RhbmNlIHR5cGUgc2VsZWN0ZWQgYnkgQXpTZWxlY3RvciBmb3IgJHttb2RlbElkfUAke3ZlcnNpb259YCxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBgJHtwcmVmaXh9U2VsZWN0ZWRBWmAsIHtcbiAgICAgIHZhbHVlOiBhelNlbGVjdG9yLmF2YWlsYWJpbGl0eVpvbmUsXG4gICAgICBkZXNjcmlwdGlvbjogYEF2YWlsYWJpbGl0eSB6b25lIHNlbGVjdGVkIGJ5IEF6U2VsZWN0b3IgZm9yICR7bW9kZWxJZH1AJHt2ZXJzaW9ufWAsXG4gICAgfSk7XG5cbiAgICAvLyBTU006IC92bGEtaHViLzxtb2RlbElkPi88dmVyc2lvbi1zYWZlPi9ncnBjLWVuZHBvaW50IChjb25zdW1lZCBieSBlbmFibGVtZW50LXBhY2sgZGVwbG95LnB5KVxuICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIGAke3ByZWZpeH1Tc21HcnBjRW5kcG9pbnRgLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiBgL3ZsYS1odWIvJHttb2RlbElkfS8ke3ZlcnNpb25TYWZlLnRvTG93ZXJDYXNlKCl9L2dycGMtZW5kcG9pbnRgLFxuICAgICAgc3RyaW5nVmFsdWU6IGAke25sYi5sb2FkQmFsYW5jZXJEbnNOYW1lfToke2dycGNQb3J0fWAsXG4gICAgfSk7XG4gIH1cbn1cblxuLy8g4pSA4pSAIFVzZXJEYXRhIGJ1aWxkZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmZ1bmN0aW9uIGJ1aWxkVXNlckRhdGEodXNlTnZpZGlhUnVudGltZTogYm9vbGVhbik6IGVjMi5Vc2VyRGF0YSB7XG4gIGNvbnN0IHVkID0gZWMyLlVzZXJEYXRhLmZvckxpbnV4KCk7XG5cbiAgY29uc3QgZGFlbW9uSnNvbiA9IHVzZU52aWRpYVJ1bnRpbWVcbiAgICA/ICd7XCJkYXRhLXJvb3RcIjogXCIvdmFyL2xpYi9kb2NrZXItZGF0YVwiLCBcImRlZmF1bHQtcnVudGltZVwiOiBcIm52aWRpYVwiLCBcInJ1bnRpbWVzXCI6IHtcIm52aWRpYVwiOiB7XCJwYXRoXCI6IFwibnZpZGlhLWNvbnRhaW5lci1ydW50aW1lXCIsIFwicnVudGltZUFyZ3NcIjogW119fX0nXG4gICAgOiAne1wiZGF0YS1yb290XCI6IFwiL3Zhci9saWIvZG9ja2VyLWRhdGFcIn0nO1xuXG4gIHVkLmFkZENvbW1hbmRzKFxuICAgICdlY2hvIEVDU19FTkFCTEVfR1BVX1NVUFBPUlQ9dHJ1ZSA+PiAvZXRjL2Vjcy9lY3MuY29uZmlnJyxcbiAgICAnc3lzdGVtY3RsIHN0b3AgZWNzJyxcbiAgICAnc3lzdGVtY3RsIHN0b3AgZG9ja2VyJyxcbiAgICAnbWtmcy54ZnMgL2Rldi94dmRjeicsXG4gICAgJ21rZGlyIC1wIC92YXIvbGliL2RvY2tlci1kYXRhJyxcbiAgICAnbW91bnQgL2Rldi94dmRjeiAvdmFyL2xpYi9kb2NrZXItZGF0YScsXG4gICAgJ2VjaG8gXCIvZGV2L3h2ZGN6IC92YXIvbGliL2RvY2tlci1kYXRhIHhmcyBkZWZhdWx0cyxub2ZhaWwgMCAyXCIgPj4gL2V0Yy9mc3RhYicsXG4gICAgJ21rZGlyIC1wIC9ldGMvZG9ja2VyJyxcbiAgICBgZWNobyAnJHtkYWVtb25Kc29ufScgPiAvZXRjL2RvY2tlci9kYWVtb24uanNvbmAsXG4gICAgJ3N5c3RlbWN0bCBzdGFydCBkb2NrZXInLFxuICAgICdzeXN0ZW1jdGwgc3RhcnQgLS1uby1ibG9jayBlY3MnLFxuICApO1xuICByZXR1cm4gdWQ7XG59XG4iXX0=