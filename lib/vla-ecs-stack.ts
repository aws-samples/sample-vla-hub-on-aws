import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { AzSelectorConstruct } from './az-selector.js';

/**
 * Single-GPU instance type fallback orders per model.
 *
 * GR00T: requires FlashAttention → Ampere GPU or newer (SM80+).
 *   g6: NVIDIA L4 (Ada Lovelace, SM89) ✅ preferred
 *   g5: NVIDIA A10G (Ampere, SM86)     ✅ alternative
 *   NOTE: g4dn (T4, SM75) and p3 (V100, SM70) are NOT supported.
 *
 * PI (π0.5): uses JAX — FlashAttention is NOT required.
 *   g5: NVIDIA A10G (Ampere, SM86) ✅ preferred (24 GB VRAM)
 *   g6: NVIDIA L4 (Ada Lovelace, SM89) ✅ alternative
 */
const DEFAULT_INSTANCE_TYPES: Record<ModelId, string[]> = {
  gr00t: [
    'g6.2xlarge',  // L4 × 1, 8 vCPU, 32 GB — preferred
    'g5.2xlarge',  // A10G × 1, 8 vCPU, 32 GB — g6 대안
    'g6.xlarge',   // L4 × 1, 4 vCPU, 16 GB — capacity 부족 시 대안
    'g5.xlarge',   // A10G × 1, 4 vCPU, 16 GB — 최후 수단
  ],
  pi: [
    'g5.2xlarge',  // A10G × 1, 8 vCPU, 32 GB — preferred
    'g5.xlarge',   // A10G × 1, 4 vCPU, 16 GB — capacity 부족 시 대안
    'g6.2xlarge',  // L4 × 1, 8 vCPU, 32 GB — g5 대안
    'g6.xlarge',   // L4 × 1, 4 vCPU, 16 GB — 최후 수단
  ],
  openvla: [
    'g5.2xlarge',  // A10G × 1, 24 GB VRAM — 7B BF16 (~14 GB) 적합 (preferred)
    'g5.xlarge',   // A10G × 1, 24 GB VRAM — capacity 부족 시 대안
    'g6.2xlarge',  // L4 × 1, 24 GB VRAM — g5 대안
    'g6.xlarge',   // L4 × 1, 24 GB VRAM — 최후 수단
  ],
  smolvla: [
    'g5.xlarge',   // A10G × 1 — 2 GB VRAM 모델이라 xlarge 충분 (preferred, 가장 저렴)
    'g6.xlarge',   // L4 × 1 — g5 대안
    'g5.2xlarge',  // capacity 부족 시
    'g6.2xlarge',  // 최후 수단
  ],
  lap: [
    // LAP-3B (JAX): FlashAttention 불필요. ~12-16 GB VRAM → xlarge(24 GB) 충분.
    'g6.xlarge',   // L4 × 1, 24 GB VRAM — preferred (paper RTX4090 ~25Hz 대비 충분)
    'g5.xlarge',   // A10G × 1, 24 GB VRAM — g6 대안
    'g6.2xlarge',  // L4 × 1 — capacity 부족 시
    'g5.2xlarge',  // A10G × 1 — 최후 수단
  ],
};

export type ModelId = 'gr00t' | 'pi' | 'openvla' | 'smolvla' | 'lap';

export interface VlaEcsStackProps extends cdk.StackProps {
  modelId: ModelId;
  ecrImageUri: string;
  instanceTypes?: string[];
  desiredCount?: number;
}

export class VlaEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VlaEcsStackProps) {
    super(scope, id, props);

    const { modelId } = props;
    const instanceTypes = props.instanceTypes ?? DEFAULT_INSTANCE_TYPES[modelId];
    const desiredCount  = props.desiredCount  ?? 1;

    // Per-model config
    const modelConfig = MODEL_CONFIGS[modelId];

    // ── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,              cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ── AzSelector ───────────────────────────────────────────────────────────
    // ECS GPU AMI is SSM-backed; CloudFormation resolves the SSM dynamic reference
    // before passing the value to the custom resource Lambda handler.
    const ecsGpuAmi = ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU);
    const probeAmiId = ecsGpuAmi.getImage(this).imageId;

    const azSelector = new AzSelectorConstruct(this, 'AzSelector', {
      instanceTypes,
      amiId: probeAmiId,
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });

    // ── ECS Cluster ──────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: modelConfig.clusterName,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── GPU Auto Scaling Group ───────────────────────────────────────────────
    // AzSelector probed capacity at deploy time; pin ASG to the confirmed subnet.
    const selectedSubnet = ec2.Subnet.fromSubnetAttributes(this, 'AzSelectedSubnet', {
      subnetId: azSelector.subnetId,
      availabilityZone: azSelector.availabilityZone,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'GpuAsg', {
      vpc,
      vpcSubnets: { subnets: [selectedSubnet] },
      instanceType: new ec2.InstanceType(azSelector.resolvedInstanceType),
      machineImage: ecsGpuAmi,
      minCapacity: 0,
      maxCapacity: 2,
      desiredCapacity: 1,
      // ECS GPU AMI notes (Amazon Linux 2, Docker overlay2):
      //   - ECS_ENABLE_GPU_SUPPORT=true: required for GPU UUID registration
      //   - /dev/xvdcz: attached but NOT auto-mounted (overlay2, not devicemapper LVM)
      //     → must explicitly format + mount + set Docker data-root in userdata
      //   - Root volume (/dev/xvda): 30 GB default → too small for large model images
      userData: buildUserData(modelConfig.useNvidiaRuntime),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(50, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
        {
          // Docker data root — formatted and mounted via userdata above
          deviceName: '/dev/xvdcz',
          volume: autoscaling.BlockDeviceVolume.ebs(200, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, 'GpuCapacityProvider', {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      capacityProviderName: modelConfig.capacityProviderName,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    // ── Task Definition ──────────────────────────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ECS Exec requires SSM Session Manager permissions on the task role
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${modelConfig.clusterName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EC2 launch type required for GPU; BRIDGE networking for port mapping
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.BRIDGE,
      taskRole,
    });

    // Grant execution role ECR pull permissions.
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    taskDef.addContainer(modelId, {
      image: ecs.ContainerImage.fromRegistry(props.ecrImageUri),
      memoryReservationMiB: modelConfig.memoryReservationMiB,
      gpuCount: 1,
      environment: modelConfig.containerEnv,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: modelId,
        logGroup,
      }),
      portMappings: [
        // Both ports are FIXED (hostPort == containerPort).
        // Safety: we run exactly 1 task per instance (desiredCapacity:1, 1 GPU per host),
        //   so fixed ports are never contested.
        { containerPort: 50051, hostPort: 50051 /* fixed — gRPC inference server */ },
        { containerPort: 8080,  hostPort: 8080  /* fixed — HTTP health server    */ },
      ],
      healthCheck: {
        // serve.py starts the HTTP health server only AFTER model loads.
        // startPeriod gives ECS the window before health check failures count.
        command:     ['CMD-SHELL', '/opt/ml/code/check_health.sh'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(10),
        retries:     3,
        startPeriod: cdk.Duration.seconds(300),
      },
    });

    // ── ECS Service ──────────────────────────────────────────────────────────
    const service = new ecs.Ec2Service(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount,
      capacityProviderStrategies: [{
        capacityProvider: capacityProvider.capacityProviderName,
        weight: 1,
      }],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // circuitBreaker: { rollback: true },  // enable after deployment confirmed stable
      enableExecuteCommand: true,
      // Grace period: ECS ignores LB health check failures for this duration.
      // Model loads + JIT warmup (~5 min), then HTTP health server starts.
      // NLB becomes healthy 60s after health server starts (2 × 30s interval).
      // Total: 300s model + 60s NLB = 360s.
      healthCheckGracePeriod: cdk.Duration.seconds(360),
    });

    // ── gRPC NLB (TCP:50051) ─────────────────────────────────────────────────
    // Internal NLB — not internet-facing; accessible only within the VPC.
    const grpcNlb = new elbv2.NetworkLoadBalancer(this, 'GrpcNlb', {
      vpc,
      internetFacing: false,
    });

    // NLB is transparent at L4 — client IPs pass through to EC2 instance.
    // Allow gRPC traffic only from within the VPC (internal NLB — no public exposure).
    asg.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(50051),
      'gRPC from VPC (internal NLB)',
    );

    const grpcListener = grpcNlb.addListener('Grpc', {
      port: 50051,
      protocol: elbv2.Protocol.TCP,
    });

    grpcListener.addTargets('GrpcTarget', {
      port: 50051,
      protocol: elbv2.Protocol.TCP,
      targets: [
        service.loadBalancerTarget({ containerName: modelId, containerPort: 50051 }),
      ],
      healthCheck: {
        // HTTP health check on fixed port 8080 (serve.py HTTP health server).
        // Returns 200 only after model is loaded — NLB stays "initializing" during startup.
        // unhealthyThresholdCount(10) × interval(30s) = 300s additional buffer after gracePeriod.
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

    // ── Security Groups ───────────────────────────────────────────────────────
    // CDK feature flag @aws-cdk/aws-elasticloadbalancingv2:networkLoadBalancerWithSecurityGroupByDefault
    // creates a security group for the NLB but does NOT auto-add egress rules (unlike ALB).
    // Must explicitly allow:
    //   (a) NLB outbound → EC2:8080 (HTTP health checks)
    //   (b) NLB outbound → EC2:50051 (gRPC traffic forwarding)
    //   (c) NLB inbound ← VPC CIDR:50051 (gRPC clients within VPC only — internal NLB)
    grpcNlb.connections.allowTo(asg, ec2.Port.tcp(8080),  'NLB to EC2 HTTP health check');
    grpcNlb.connections.allowTo(asg, ec2.Port.tcp(50051), 'NLB to EC2 gRPC');
    grpcNlb.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(50051),
      'gRPC clients within VPC',
    );

    // NLB health check source IPs are VPC-internal (NLB ENI IPs).
    // Port 8080 is fixed (hostPort: 8080) — allow from full VPC CIDR.
    asg.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8080),
      'NLB HTTP health check on fixed port 8080',
    );

    // ── ECS Service Auto Scaling ──────────────────────────────────────────────
    // Scale ECS service task count (1→2) based on CPU utilization.
    // AsgCapacityProvider (enableManagedScaling: true) automatically scales the
    // underlying ASG when ECS needs more capacity — no separate ASG policy needed.
    //
    // GPU instance startup (EC2 boot + ECS agent + model load) takes ~10 min total,
    // so scale-in cooldown is set to 15 min to prevent flapping.
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 2,  // matches ASG maxCapacity
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.minutes(2),
      scaleInCooldown:  cdk.Duration.minutes(15),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GrpcEndpoint', {
      value: `${grpcNlb.loadBalancerDnsName}:50051`,
      description: `gRPC inference endpoint for ${modelId} (internal NLB — VPC-only).`,
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID — place gRPC client EC2 in this VPC to reach the NLB',
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: vpc.privateSubnets.map(s => s.subnetId).join(','),
      description: 'Private subnet IDs — place gRPC client EC2 in one of these subnets',
    });
    new cdk.CfnOutput(this, 'ClusterName',         { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName',          { value: service.serviceName });
    new cdk.CfnOutput(this, 'SelectedInstanceType', { value: azSelector.resolvedInstanceType, description: 'GPU instance type selected by AzSelector' });
    new cdk.CfnOutput(this, 'SelectedAZ',           { value: azSelector.availabilityZone,     description: 'Availability zone selected by AzSelector' });

    // ── cdk-nag Suppressions ──────────────────────────────────────────────────

    NagSuppressions.addResourceSuppressions(vpc, [
      { id: 'AwsSolutions-VPC7', reason: 'Sample project: VPC Flow Logs add cost and operational overhead not warranted for a demo deployment.' },
    ]);

    NagSuppressions.addResourceSuppressions(taskDef, [
      { id: 'AwsSolutions-ECS2', reason: 'Container environment variables are non-sensitive model config identifiers, not secrets. Injecting them via SSM/SM would add unnecessary complexity for a sample project.' },
    ], true);

    NagSuppressions.addResourceSuppressions(grpcNlb, [
      { id: 'AwsSolutions-ELB2', reason: 'Sample project: NLB access logging adds S3 storage cost not warranted for a demo deployment.' },
    ]);

    NagSuppressions.addResourceSuppressions(asg, [
      { id: 'AwsSolutions-AS3', reason: 'Sample project: ASG scaling notifications not required. The GPU ASG runs exactly 1 task; scale events trigger only on ECS capacity changes.' },
    ]);

    NagSuppressions.addResourceSuppressions(asg, [
      { id: 'AwsSolutions-EC23', reason: 'gRPC port 50051 is restricted to vpc.vpcCidrBlock only. The NLB is internal (not internet-facing); all gRPC clients must reside in the same VPC.' },
    ], true);
    NagSuppressions.addResourceSuppressions(grpcNlb, [
      { id: 'AwsSolutions-EC23', reason: 'Internal NLB: gRPC port 50051 is restricted to vpc.vpcCidrBlock. No public internet access — VPC-level isolation enforced.' },
    ], true);

    NagSuppressions.addResourceSuppressions(taskRole, [
      { id: 'AwsSolutions-IAM5', reason: 'SSM Session Manager (ECS Exec) requires ssmmessages:Create/OpenControlChannel and DataChannel on resource * — AWS-defined scope.' },
    ], true);

    NagSuppressions.addResourceSuppressions(taskDef, [
      { id: 'AwsSolutions-IAM5', reason: 'ecr:GetAuthorizationToken and ecr:BatchCheckLayerAvailability require resource * per ECR API specification. BatchGetImage/GetDownloadUrlForLayer scoped to the specific repo.' },
    ], true);

    NagSuppressions.addResourceSuppressions(asg, [
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated ECS instance role. ecs:Submit* and wildcard resources are required for the ECS container agent to report task status.' },
    ], true);

    NagSuppressions.addResourceSuppressions(asg, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated ECS drain lifecycle hook Lambda. AWSLambdaBasicExecutionRole is the minimum managed policy for CloudWatch Logs access.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated ECS drain lifecycle hook Lambda. ASG and ECS resource wildcards are required by CDK\'s built-in drain hook implementation.' },
      { id: 'AwsSolutions-L1',   reason: 'CDK-generated ECS drain lifecycle hook Lambda. Runtime version is managed by CDK internally.' },
      { id: 'AwsSolutions-SNS3', reason: 'CDK-generated ECS drain lifecycle hook SNS topic. SSL enforcement not applicable to internally-triggered lifecycle notifications.' },
    ], true);
  }
}

// ── Per-model configuration ───────────────────────────────────────────────────

interface ModelConfig {
  clusterName: string;
  capacityProviderName: string;
  memoryReservationMiB: number;
  containerEnv: Record<string, string>;
  // true for pi (JAX): daemon.json must set nvidia as default runtime so ECS registers ecs.capability.nvidia-gpu
  // false for gr00t (PyTorch): ECS GPU AMI already includes nvidia runtime; no explicit override needed
  useNvidiaRuntime: boolean;
}

const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  gr00t: {
    clusterName: 'gr00t-realtime',
    capacityProviderName: 'gr00t-gpu-cp',
    // Reserve 20 GB RAM; leave headroom for OS/ECS agent on g5/g6.2xlarge (32 GB)
    memoryReservationMiB: 20480,
    containerEnv: {
      HF_MODEL_ID:    'nvidia/GR00T-N1.6-3B',
      EMBODIMENT_TAG: 'GR1',
    },
    useNvidiaRuntime: false,
  },
  pi: {
    clusterName: 'vla-pi-realtime',
    capacityProviderName: 'pi-gpu-cp',
    // Reserve 12 GB RAM. g5.xlarge has ~15.8 GB available to ECS; pi0.5 model is ~10 GB in JAX.
    memoryReservationMiB: 12288,
    containerEnv: {
      MODEL_CONFIG:         'pi05_libero',
      MODEL_CHECKPOINT_DIR: '/opt/pi-cache/checkpoints/pi05_libero',
    },
    useNvidiaRuntime: true,
  },
  openvla: {
    clusterName: 'vla-openvla-realtime',
    capacityProviderName: 'openvla-gpu-cp',
    // Reserve 20 GB RAM; OpenVLA-7B BF16 ~14 GB; 20 GB on g5.2xlarge (32 GB)
    memoryReservationMiB: 20480,
    containerEnv: {
      HF_MODEL_ID: 'openvla/openvla-7b',
      DEVICE:      'cuda:0',
    },
    useNvidiaRuntime: false,
  },
  smolvla: {
    clusterName: 'vla-smolvla-realtime',
    capacityProviderName: 'smolvla-gpu-cp',
    // SmolVLA 450M: ~1 GB 모델 + LeRobot/PyTorch runtime
    memoryReservationMiB: 8192,
    containerEnv: {
      HF_MODEL_ID: 'lerobot/smolvla_base',
      DEVICE:      'cuda:0',
    },
    useNvidiaRuntime: false,
  },
  lap: {
    clusterName: 'vla-lap-realtime',
    capacityProviderName: 'lap-gpu-cp',
    // LAP-3B: JAX 런타임 ~12-16 GB; g6/g5.xlarge (~15.8 GB available)에 12 GB reservation
    memoryReservationMiB: 12288,
    containerEnv: {
      MODEL_CONFIG:         'lap_libero',
      MODEL_CHECKPOINT_DIR: '/opt/lap-cache/checkpoints/lap_libero',
    },
    useNvidiaRuntime: true,  // JAX: ECS가 ecs.capability.nvidia-gpu 등록하도록 default-runtime=nvidia 필요
  },
};

// ── UserData builder ──────────────────────────────────────────────────────────

function buildUserData(useNvidiaRuntime: boolean): ec2.UserData {
  const ud = ec2.UserData.forLinux();

  const daemonJson = useNvidiaRuntime
    // Set nvidia as the default Docker runtime so ECS agent registers ecs.capability.nvidia-gpu.
    // Must also preserve data-root. ECS GPU AMI normally sets nvidia runtime, but since we
    // write daemon.json from userdata we must include it explicitly.
    ? '{"data-root": "/var/lib/docker-data", "default-runtime": "nvidia", "runtimes": {"nvidia": {"path": "nvidia-container-runtime", "runtimeArgs": []}}}'
    : '{"data-root": "/var/lib/docker-data"}';

  ud.addCommands(
    // GPU support — must be set before ECS agent starts
    'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config',
    // Move Docker data root to /dev/xvdcz (200 GB EBS volume).
    // NOTE: Do NOT call `systemctl start ecs` here.
    // ECS service unit has `After=cloud-final.service`; calling systemctl start inside
    // cloud-init creates a deadlock. Use --no-block to avoid this.
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
