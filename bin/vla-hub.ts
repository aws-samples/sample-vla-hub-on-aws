#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { VlaBuildStack } from '../lib/vla-build-stack.js';
import { VlaHubStack, ModelConfig } from '../lib/vla-hub-stack.js';
import { ModelId } from '../lib/vla-ecs-stack.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hubConfig = require('../vla-hub.json') as { models: ModelConfig[] };

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
};

// ── Phase 1: ECR + CodeBuild (one stack per model@version) ───────────────────
// cdk deploy Gr00tN1-6BuildStack
// cdk deploy Pi0-5BuildStack
for (const model of hubConfig.models) {
  const idPart      = model.id.charAt(0).toUpperCase() + model.id.slice(1);
  const versionSafe = model.version.replace(/[^a-zA-Z0-9]/g, '-');
  const stackName   = `${idPart}${versionSafe}BuildStack`;
  new VlaBuildStack(app, stackName, {
    env,
    modelId: model.id as ModelId,
    version: model.version,
  });
}

// ── Phase 2: VlaHubStack (single shared NLB + per-model ECS/ASG) ─────────────
// After Phase 1 completes, override ECR image URIs via JSON config or context:
//   ecrImageUri in vla-hub.json per model, or:
//   cdk deploy VlaHubStack -c gr00tEcrImageUri=<uri> -c piEcrImageUri=<uri>
//
// Apply context-level ECR URI overrides (optional)
const modelsWithOverrides: ModelConfig[] = hubConfig.models.map(m => {
  const ctxKey = `${m.id}EcrImageUri`;
  const override = app.node.tryGetContext(ctxKey) as string | undefined;
  return override ? { ...m, ecrImageUri: override } : m;
});

new VlaHubStack(app, 'VlaHubStack', { env, models: modelsWithOverrides });

// cdk-nag: run AwsSolutions rule pack across all stacks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
