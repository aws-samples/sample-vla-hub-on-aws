/**
 * AzSelectorConstruct
 *
 * Custom Resource Lambda를 사용하여 배포 시점에 GPU 인스턴스 capacity가 있는
 * 가용 영역과 인스턴스 타입을 자동으로 탐색하는 Construct.
 *
 * 동작 방식:
 * 1. 인스턴스 타입 fallback 리스트를 순차 시도 (예: g6.2xlarge → g5.2xlarge → g6.xlarge → g5.xlarge)
 * 2. 각 인스턴스 타입에 대해 describe-instance-type-offerings로 지원 AZ 목록 조회
 * 3. AZ 목록을 셔플하여 특정 AZ 집중 방지
 * 4. 각 AZ에서 RunInstances (MinCount=1) 시도
 * 5. 성공하면 즉시 terminate하고 해당 AZ + 인스턴스 타입 반환
 * 6. InsufficientInstanceCapacity이면 다음 AZ 시도
 * 7. 해당 타입의 모든 AZ 실패 시 다음 인스턴스 타입으로 fallback
 * 8. 모든 타입/AZ 실패 시 에러 반환
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface AzSelectorProps {
  /** 인스턴스 타입 fallback 리스트 (우선순위 순) */
  instanceTypes: string[];
  /** 탐색에 사용할 AMI ID (probe용; capacity 확인만 하므로 실제 배포 AMI와 달라도 무방) */
  amiId: string;
  /** VPC Subnet ID 목록 — Lambda가 AZ를 직접 조회하여 올바른 Subnet을 반환 */
  subnetIds: string[];
}

export class AzSelectorConstruct extends Construct {
  /** 탐색된 가용 영역 이름 (CloudFormation 런타임 값) */
  public readonly availabilityZone: string;
  /** 탐색된 인스턴스 타입 (CloudFormation 런타임 값) */
  public readonly resolvedInstanceType: string;
  /** capacity가 확인된 AZ의 Subnet ID (CloudFormation 런타임 값) */
  public readonly subnetId: string;

  constructor(scope: Construct, id: string, props: AzSelectorProps) {
    super(scope, id);

    const lambdaRole = new iam.Role(this, 'AzSelectorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        AzSelectorPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ec2:DescribeInstanceTypeOfferings',
                'ec2:DescribeSubnets',
                'ec2:RunInstances',
                'ec2:TerminateInstances',
                'ec2:DescribeInstances',
                'ec2:CreateTags',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const azSelectorFn = new lambda.Function(this, 'AzSelectorFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(10),
      code: lambda.Code.fromInline(AZ_SELECTOR_LAMBDA_CODE),
      description: 'Finds AZ + instance type with GPU capacity by trial launch with fallback',
    });

    const customResource = new cdk.CustomResource(this, 'AzSelectorResource', {
      serviceToken: azSelectorFn.functionArn,
      properties: {
        InstanceTypes: props.instanceTypes.join(','),
        AmiId: props.amiId,
        SubnetIds: props.subnetIds.join(','),
        Timestamp: Date.now().toString(),
      },
    });

    azSelectorFn.addPermission('CfnInvoke', {
      principal: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    });

    this.availabilityZone = customResource.getAttString('AvailabilityZone');
    this.resolvedInstanceType = customResource.getAttString('InstanceType');
    this.subnetId = customResource.getAttString('SubnetId');

    // ── cdk-nag Suppressions ─────────────────────────────────────────────────

    NagSuppressions.addResourceSuppressions(lambdaRole, [
      { id: 'AwsSolutions-IAM4', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], reason: 'AWSLambdaBasicExecutionRole grants only CloudWatch Logs write access, which is the minimum required for Lambda execution logging.' },
    ]);

    NagSuppressions.addResourceSuppressions(lambdaRole, [
      { id: 'AwsSolutions-IAM5', reason: 'AzSelector Lambda must probe EC2 capacity across all AZs and instance types in the VPC. Resource * is required for ec2:DescribeInstanceTypeOfferings, RunInstances, and TerminateInstances since the target AZ/subnet is unknown at synth time.' },
    ], true);

    NagSuppressions.addResourceSuppressions(azSelectorFn, [
      { id: 'AwsSolutions-L1', reason: 'Python 3.13 is the latest available Python Lambda runtime as of the time of writing.' },
    ]);
  }
}

const AZ_SELECTOR_LAMBDA_CODE = `
import json
import boto3
import random
import cfnresponse

def handler(event, context):
    print(json.dumps(event))

    if event['RequestType'] == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {},
            physicalResourceId=event.get('PhysicalResourceId', 'az-selector-deleted'))
        return

    try:
        instance_types = event['ResourceProperties']['InstanceTypes'].split(',')
        ami_id = event['ResourceProperties']['AmiId']
        subnet_ids = event['ResourceProperties']['SubnetIds'].split(',')
        region = context.invoked_function_arn.split(':')[3]

        ec2 = boto3.client('ec2', region_name=region)

        subnets_resp = ec2.describe_subnets(SubnetIds=subnet_ids)
        subnet_az_map = {s['SubnetId']: s['AvailabilityZone'] for s in subnets_resp['Subnets']}
        print(f'Subnet AZ map: {subnet_az_map}')

        all_tried = []

        for instance_type in instance_types:
            print(f'--- Trying instance type: {instance_type} ---')

            resp = ec2.describe_instance_type_offerings(
                LocationType='availability-zone',
                Filters=[{'Name': 'instance-type', 'Values': [instance_type]}]
            )
            supported_azs = {o['Location'] for o in resp['InstanceTypeOfferings']}
            print(f'Supported AZs for {instance_type}: {supported_azs}')

            candidates = [(sid, az) for sid, az in subnet_az_map.items() if az in supported_azs]
            if not candidates:
                print(f'{instance_type} not available in any VPC subnet AZ, skipping...')
                all_tried.append(f'{instance_type}(no subnet AZ match)')
                continue

            random.shuffle(candidates)

            for subnet_id, az in candidates:
                print(f'Trying {instance_type} in {az} (subnet: {subnet_id})')
                try:
                    run_resp = ec2.run_instances(
                        InstanceType=instance_type,
                        ImageId=ami_id,
                        MinCount=1,
                        MaxCount=1,
                        SubnetId=subnet_id,
                        TagSpecifications=[{
                            'ResourceType': 'instance',
                            'Tags': [{'Key': 'Name', 'Value': 'az-selector-probe'}]
                        }]
                    )
                    instance_id = run_resp['Instances'][0]['InstanceId']
                    print(f'SUCCESS: {instance_type} in {az} subnet {subnet_id} (probe: {instance_id})')

                    ec2.terminate_instances(InstanceIds=[instance_id])
                    print(f'Terminated probe {instance_id}')

                    cfnresponse.send(event, context, cfnresponse.SUCCESS,
                        {'AvailabilityZone': az, 'InstanceType': instance_type, 'SubnetId': subnet_id},
                        physicalResourceId=f'az-selector-{az}-{instance_type}')
                    return

                except Exception as e:
                    error_msg = str(e)
                    if 'InsufficientInstanceCapacity' in error_msg:
                        print(f'InsufficientCapacity: {instance_type} in {az}')
                        all_tried.append(f'{instance_type}/{az}')
                        continue
                    elif 'Unsupported' in error_msg:
                        print(f'Unsupported: {instance_type} in {az}')
                        all_tried.append(f'{instance_type}/{az}(unsupported)')
                        continue
                    else:
                        print(f'Unexpected error: {e}')
                        raise

            print(f'All subnets exhausted for {instance_type}, falling back...')

        cfnresponse.send(event, context, cfnresponse.FAILED, {},
            reason=f'No capacity available for any instance type in VPC subnets: {all_tried}',
            physicalResourceId='az-selector-failed')

    except Exception as e:
        print(f'Error: {e}')
        cfnresponse.send(event, context, cfnresponse.FAILED, {},
            reason=str(e),
            physicalResourceId='az-selector-error')
`;
