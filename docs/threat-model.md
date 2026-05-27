# Threat Model — vla-hub-on-aws

**Version**: 1.1  
**Date**: 2026-04-24  
**Author**: AWS SA  
**Reviewer**: AWS Security (Talos)  
**Status**: Draft — Pending Guardian Review

---

## 1. System Description

### 1.1 Overview

`vla-hub-on-aws` is an open-source AWS CDK sample project that deploys Vision-Language-Action (VLA) inference servers on AWS ECS (EC2 launch type). It supports two VLA model families:

- **NVIDIA GR00T N1/N1.5/N1.6** — robotic foundation model for real-time inference (gRPC)
- **Physical Intelligence π0.5/0.6/0.7** — JAX-based VLA model for robot policy inference (gRPC)

The project provides a CDK stack (`VlaHubStack`) that creates the infrastructure for hosting one or more VLA models behind a shared internal NLB. A separate build stack (`VlaBuildStack`) builds Docker images via AWS CodeBuild and stores them in Amazon ECR.

**Intended use**: Research, development, and demonstration deployments of VLA inference in AWS environments. Not intended for production workloads without additional hardening.

### 1.2 Deployment Context

- **AWS Account**: Customer-owned AWS account
- **Region**: Any AWS region with G5/G6 GPU instance availability (default: us-east-1)
- **Deployer**: Developer with AWS CDK deploy permissions
- **End Users**: Robotics engineers or researchers accessing gRPC endpoints within the same VPC
- **Data**: Model inference requests (sensor observations, images) and action responses — no persistent data storage

### 1.3 Technology Stack

| Component | Technology |
|-----------|-----------|
| Infrastructure | AWS CDK (TypeScript) |
| Compute | Amazon ECS on EC2 (g5/g6 GPU instances) |
| Container Registry | Amazon ECR |
| Build System | AWS CodeBuild |
| Load Balancing | AWS Network Load Balancer (internal) |
| Networking | Amazon VPC (public + private subnets, NAT Gateway) |
| Secrets | AWS Secrets Manager (HuggingFace token) |
| Logging | Amazon CloudWatch Logs |
| Model: GR00T | PyTorch, served via gRPC (custom serve.py) |
| Model: π (pi) | JAX, served via gRPC (custom serve.py) |

---

## 2. Architecture Overview

### 2.1 High-Level Architecture

```
[Developer/CI]
      |
      | CDK deploy
      v
[AWS CodeBuild]  <-- HF Token (Secrets Manager, gr00t only)
      |               Docker source (S3/CDK bootstrap bucket)
      | docker push
      v
[Amazon ECR]
      |
      | image pull (at task startup)
      v
[Amazon VPC: 10.0.0.0/16]
  ┌─────────────────────────────────────────────────────┐
  │  Public Subnets (/24 × 2 AZ)                        │
  │    [NAT Gateway] ← Internet Gateway → Internet       │
  │                                                      │
  │  Private Subnets (/24 × 2 AZ)                       │
  │    [Internal NLB]  (not internet-facing)             │
  │         | TCP:50051 (GR00T)                          │
  │         | TCP:50052 (π)                              │
  │         v                                            │
  │    [ECS EC2 Instance] (g5/g6, GPU)                  │
  │      [ECS Task Container]                            │
  │        - gRPC inference server (port 50051/50052)   │
  │        - HTTP health server (port 8080)              │
  │        - CloudWatch Logs agent                       │
  │                                                      │
  │    [gRPC Client EC2]  (same VPC, same subnet)        │
  │      → NLB DNS:port → inference request              │
  └─────────────────────────────────────────────────────┘
            |
            | HTTPS (443) via NAT Gateway
            v
    [AWS API Endpoints: ECR, CloudWatch, SSM, etc.]
```

### 2.2 Network Zones / Trust Boundaries

| Zone | Description | Trust Level |
|------|-------------|-------------|
| **Internet** | Public internet | Untrusted |
| **VPC** | Private VPC (10.0.0.0/16) | Semi-trusted (VPC-internal callers) |
| **ECS Task** | Running container | Trusted (AWS-managed IAM) |
| **AWS Control Plane** | ECR, CloudWatch, SSM, Secrets Manager | Trusted (AWS-managed) |
| **Developer Workstation** | CDK deploy origin | Trusted (authenticated) |

**Primary Trust Boundary**: VPC boundary. The internal NLB accepts traffic only from within the VPC CIDR (10.0.0.0/16). No internet-facing endpoints exist.

### 2.3 Data Classification

| Data Type | Sensitivity | Storage | In Transit |
|-----------|-------------|---------|------------|
| VLA inference requests (observations/images) | Internal | None (ephemeral) | VPC-internal TCP (unencrypted) |
| VLA action responses | Internal | None (ephemeral) | VPC-internal TCP (unencrypted) |
| HuggingFace API token | Secret | AWS Secrets Manager (encrypted at rest) | BuildKit secret mount (not stored in image) |
| Model weights (GR00T) | Confidential (NVIDIA-licensed) | ECR (encrypted at rest) | HTTPS during docker pull |
| Model weights (π0) | Confidential (Physical Intelligence-licensed) | ECR (encrypted at rest) | HTTPS during docker pull |
| Container environment vars | Non-sensitive | ECS task definition | N/A |
| Application logs | Internal | CloudWatch Logs (1 week retention) | HTTPS |

---

## 3. Data Flow Diagrams

### 3.1 Build Phase Data Flow

```
[Developer] --CDK deploy--> [CloudFormation]
                                   |
                    +--------------+--------------+
                    |                             |
            [S3 Bootstrap Bucket]         [CodeBuild Project]
            (Docker source ZIP)                   |
                                     +--- Reads: S3 (Docker source)
                                     +--- Reads: Secrets Manager (HF token, gr00t only)
                                     |
                                  [docker build]
                                     |
                                  [docker push]
                                     |
                               [Amazon ECR]
                           (encrypted at rest, private)
```

**Data flows**:
1. CDK zips `docker/<model>/` → uploads to CDK bootstrap S3 bucket
2. CodeBuild downloads ZIP → extracts Dockerfile + serve.py
3. For GR00T: CodeBuild reads `gr00t/hf-token` from Secrets Manager as `HF_TOKEN` env var; Docker BuildKit injects as `--secret` (not persisted in image layers)
4. Docker image built → pushed to ECR with tag `{version}-latest`

### 3.2 Runtime Phase Data Flow

```
[gRPC Client (EC2 in VPC)]
         |
         | TCP port 50051 (GR00T) or 50052 (π)
         | Source: VPC CIDR enforced by NLB SG
         v
[Internal NLB]  (L4 TCP pass-through, no TLS termination)
         |
         | TCP port 50051/50052
         v
[ECS EC2 Instance (GPU)]
   [ECS Task Container]
         |
         | gRPC proto (inference request: observations, images)
         v
   [VLA Inference Engine]  (PyTorch/JAX + GPU)
         |
         | gRPC proto (inference response: robot actions)
         v
[gRPC Client]
```

**Secondary flows**:
- ECS Task → NAT GW → ECR API (image pull on cold start)
- ECS Task → NAT GW → CloudWatch Logs (log streaming)
- ECS Task → SSM Session Manager (ECS Exec, operator access)
- NLB → ECS Task (HTTP:8080 health check)

### 3.3 Operator Access Data Flow

```
[Operator (developer with AWS credentials)]
         |
         | aws ecs execute-command
         v
[SSM Session Manager] (over SSM API, AWS control plane)
         |
         | SSM tunnel via ssmmessages channels
         v
[ECS Task Container] (interactive shell)
```

---

## 4. Threat Model (STRIDE)

### 4.1 Spoofing

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| S-01 | gRPC client spoofs identity to call inference API | Internal NLB / ECS gRPC server | Medium | Medium | **No authentication on gRPC endpoint.** VPC-level network isolation is the only control. Any EC2 instance in the VPC can call the inference API. Mitigation: deploy client EC2 in a restricted security group; add mutual TLS (mTLS) or API key auth in serve.py for production. |
| S-02 | Forged health check response | ECS Task HTTP:8080 | Low | Low | Health check is NLB-internal; not externally accessible. serve.py checks model load status before returning 200. |
| S-03 | CDK deploy from unauthorized identity | AWS Control Plane | Low | Critical | IAM-gated. CodeBuild and CloudFormation use scoped roles. Deployer requires CDK deploy permissions (IAM policy out of scope for this CDK sample). |

### 4.2 Tampering

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| T-01 | Malicious Docker image injected into ECR | Amazon ECR | Low | Critical | ECR is private; push requires `ecr:PutImage` via BuildRole. ECR image tag immutability **not enabled** — an authenticated principal could overwrite `{version}-latest` tag. **Recommendation**: enable ECR tag immutability for production. ECR scan-on-push **not configured** — vulnerabilities in base image may go undetected. |
| T-02 | Model weights tampered in Docker image | ECS Task | Low | High | Model weights are baked into the Docker image during CodeBuild. HF token used only at build time (BuildKit `--secret`); not stored in image. Image integrity relies on ECR access controls. |
| T-03 | UserData script tampered | EC2 ASG | Very Low | High | UserData is generated by CDK at deploy time. Tampering requires compromising CloudFormation/CDK execution. Launch configuration is immutable after ASG creation. |
| T-04 | CloudWatch log tampering | CloudWatch Logs | Very Low | Low | CloudWatch uses HTTPS with SigV4 authentication. ECS task writes only to its own log group (scoped ExecutionRole). |

### 4.3 Repudiation

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| R-01 | Inference call not logged | ECS gRPC server | Medium | Medium | gRPC requests are not logged at the application level. CloudWatch captures container stdout/stderr only. A malicious or erroneous inference call cannot be attributed. **Recommendation**: add request logging in serve.py (caller IP, timestamp, request shape). |
| R-02 | ECS Exec session not logged | SSM Session Manager | Low | Medium | SSM Session Manager logging to CloudWatch/S3 **not configured** in this sample. Operator actions via `execute-command` are not recorded. **Recommendation**: enable SSM session logging for audit compliance. |
| R-03 | CloudTrail not enabled | AWS Account | N/A (external) | High | CloudTrail is a customer account-level setting. API calls (CDK deploy, ECR push, ECS Exec) are logged if CloudTrail is active. Out of scope for this CDK sample, but deployers should ensure CloudTrail is enabled. |

### 4.4 Information Disclosure

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| I-01 | gRPC traffic intercepted within VPC | Internal NLB → ECS | Medium | Medium | NLB operates at L4 TCP — **no TLS**. Inference requests (sensor observations, images) transmitted in plaintext within the VPC. An EC2 instance on the same subnet could intercept traffic. **Recommendation**: implement gRPC TLS (mTLS) for production. |
| I-02 | HuggingFace token leaked via image layer | ECR / Docker image | Low | High | HF token injected via Docker BuildKit `--secret id=hf_token,env=HF_TOKEN`. Not stored in image layer history. However, if `docker history` inspection is possible, risk is low. The `gr00t/hf-token` secret in Secrets Manager is accessible only by BuildRole. |
| I-03 | Model weights exposed via ECR | Amazon ECR | Low | Confidential | ECR repository is private. Public access is blocked. Image pull requires ECR authorization token (SigV4). |
| I-04 | Container env vars expose config | ECS Task Definition | Low | Low | Container env vars include `HF_MODEL_ID`, `EMBODIMENT_TAG`, `MODEL_CONFIG`, `GRPC_PORT` — all non-sensitive. No secrets injected as env vars. (cdk-nag ECS2 suppressed with justification.) |
| I-05 | CloudWatch logs expose inference data | CloudWatch Logs | Low | Medium | Log retention is 1 week. Logs contain container stdout/stderr (serve.py output). Inference request payloads are not logged by default. CloudWatch log group access controlled by IAM. |
| I-06 | VPC Flow Logs disabled | VPC | Medium | Low | VPC Flow Logs are suppressed (cdk-nag VPC7) with sample project justification. Network traffic patterns are not recorded. **Recommendation**: enable for production deployments for security monitoring. |

### 4.5 Denial of Service

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| D-01 | GPU resource exhaustion via inference flooding | ECS Task | Medium | High | gRPC endpoint has no rate limiting or authentication. Any VPC-internal host can flood the inference server with requests, saturating GPU resources. ASG auto-scaling provides limited mitigation (adds capacity), but GPU startup takes ~10 min. **Recommendation**: implement request queuing or rate limiting in serve.py. |
| D-02 | ECS task crash loop (model OOM) | ECS Task | Low | High | Large inference batches may cause GPU OOM. ECS will attempt restart, but recovery time is ~5 min. Health check grace period (360s) prevents premature NLB deregistration. |
| D-03 | NAT Gateway saturation during image pull | NAT Gateway | Very Low | Medium | Large Docker images (15–20 GB) pulled via NAT GW. Concurrent cold starts may saturate NAT GW bandwidth. Mitigated by 1 task/instance design and ASG managed scaling. |
| D-04 | CDK bootstrap S3 bucket deleted | S3 (CDK bootstrap) | Very Low | Medium | If CDK bootstrap bucket is deleted, CodeBuild cannot download Docker source. Impact is limited to build operations; running tasks are unaffected. |

### 4.6 Elevation of Privilege

| ID | Threat | Component | Likelihood | Impact | Mitigation |
|----|--------|-----------|-----------|--------|-----------|
| E-01 | Container escape to EC2 host | ECS EC2 Instance | Low | Critical | CodeBuild runs with `privileged: true` (required for `docker build`). ECS tasks do not run privileged. However, ECS on EC2 uses BRIDGE networking — container breakout could expose host network. **Containers run as root** (no `USER` directive) due to upstream NVIDIA base image constraints — non-root support requested upstream ([Isaac-GR00T#653](https://github.com/NVIDIA/Isaac-GR00T/issues/653), [openpi#931](https://github.com/Physical-Intelligence/openpi/issues/931)). **Recommendation**: consider additional runtime security (Falco, Sysdig) for production. |
| E-02 | TaskRole abused for lateral movement | IAM TaskRole | Low | Medium | TaskRole grants `ssmmessages:*` on resource `*`. A compromised task could theoretically send SSM messages, but actual lateral movement requires additional SSM access. ECR access (ExecutionRole) is read-only. |
| E-03 | BuildRole abused for ECR/S3 access | IAM BuildRole | Low | High | BuildRole has ECR push + S3 read + Secrets Manager read (HF token only). Compromise of CodeBuild execution could allow injection of malicious images into ECR or reading the HF token. CodeBuild project is not triggered by external events — manual trigger only. |
| E-04 | ECS Exec used for unauthorized container access | SSM / ECS Exec | Low | High | ECS Exec (`enableExecuteCommand: true`) allows operators with `ecs:ExecuteCommand` IAM permission to get an interactive shell in the container. IAM policy controls access; no in-container access controls beyond IAM. |

---

## 5. Security Findings Summary

### 5.1 High Severity

| Finding | Threat ID | Recommendation |
|---------|-----------|----------------|
| gRPC endpoint has no authentication or authorization | S-01, D-01 | Add mTLS or API key authentication in serve.py; restrict NLB access to specific client security groups |
| No TLS on gRPC data path | I-01 | Implement gRPC TLS (server cert + optional mTLS) |
| ECR tag immutability not enabled | T-01 | Enable `imageTagMutability: IMMUTABLE` on ECR repositories |
| ECR scan-on-push not configured | T-01 | Enable `imageScanningConfiguration: { scanOnPush: true }` |

### 5.2 Medium Severity

| Finding | Threat ID | Recommendation |
|---------|-----------|----------------|
| TaskRole SSM permissions use resource `*` | E-02 | Scope `ssmmessages:*` to specific ECS task ARN pattern |
| VPC Flow Logs disabled | I-06 | Enable VPC Flow Logs for production |
| SSM Session Manager logging not configured | R-02 | Add SSM session logging to CloudWatch Logs or S3 |
| CloudWatch log retention 1 week (too short for audit) | R-01 | Increase retention to 90 days for security audit compliance |
| No inference request logging | R-01 | Add structured logging in serve.py (caller IP, request metadata) |

### 5.3 Low Severity / Accepted Risk (Sample Project)

| Finding | Suppression | Justification |
|---------|------------|---------------|
| NLB access logging disabled | AwsSolutions-ELB2 | Sample project — adds S3 storage cost |
| VPC Flow Logs disabled | AwsSolutions-VPC7 | Sample project — adds cost and operational overhead |
| ASG scaling notifications disabled | AwsSolutions-AS3 | Sample project — 1 task/instance design |
| Container env vars not in SSM/SM | AwsSolutions-ECS2 | Env vars are non-sensitive model config identifiers |
| CodeBuild uses AES-256 (not KMS CMK) | AwsSolutions-CB4 | Sample project — KMS CMK adds cost |
| **Container runs as root (SEC-001)** | SEC-001 | **Accepted Risk** — NVIDIA base images (`nvcr.io/nvidia/pytorch:25.03-py3`, `nvcr.io/nvidia/cuda:12.3.2-cudnn9-devel-ubuntu22.04`) do not provide a validated non-root execution path for GPU workloads. Root-owned paths (`/opt/hf-cache`, `/root/.local/bin`) and GPU driver initialization dependencies make non-root migration a breaking upstream change. Non-root support has been requested upstream (see below). Compensating controls: ECS task isolation (no `--privileged` flag), VPC-only network access, IAM-scoped TaskRole. |

**Upstream non-root issues filed**:
- Isaac-GR00T: https://github.com/NVIDIA/Isaac-GR00T/issues/653
- openpi: https://github.com/Physical-Intelligence/openpi/issues/931

---

## 6. Security Controls in Place

| Control | Implementation |
|---------|---------------|
| Network isolation | Internal NLB (not internet-facing); SG restricts gRPC to VPC CIDR only |
| IAM least privilege | Separate ExecutionRole (ECR pull + CW Logs) and TaskRole (SSM Exec only) |
| Secrets management | HF token stored in AWS Secrets Manager; injected via BuildKit `--secret` (not in image layers) |
| Encryption at rest | EBS volumes encrypted (gp3, encrypted: true); ECR encrypted by default; Secrets Manager encrypted by default |
| Encryption in transit | ECR pull, CloudWatch Logs, SSM over HTTPS/TLS; gRPC endpoint uses plaintext TCP (see I-01) |
| Access control | All AWS resources require IAM authentication; no unauthenticated AWS API access |
| Health monitoring | NLB health checks (HTTP:8080/health); CloudWatch Container Insights v2 |
| Supply chain | Model weights sourced from official HuggingFace (NVIDIA) and GCS (Physical Intelligence) repositories |

---

## 7. Out of Scope

The following items are outside the threat model for this sample project:

- IAM policies of the CDK deployer (customer responsibility)
- AWS account-level security controls (CloudTrail, AWS Config, Security Hub)
- Network controls external to the VPC (Transit Gateway, firewall appliances)
- Robot hardware and physical security
- gRPC client security (customer's robotics application)
- Data at rest on robot/client side
- NVIDIA GR00T and Physical Intelligence π model training pipeline security
- Supply chain security of NVIDIA/Physical Intelligence model weights

---

## 8. Related Documents

- System Design Diagram: `docs/system-design.drawio` (Task 1, Talos Related Items)
- Talos Engagement: (internal link — not public)
- CDK Source: `lib/vla-hub-stack.ts`, `lib/vla-build-stack.ts`, `lib/vla-ecs-stack.ts`
- AWS Threat Modeling: https://aws.amazon.com/blogs/security/how-to-approach-threat-modeling/
