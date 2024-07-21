import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as assets from 'aws-cdk-lib/aws-s3-assets'
import * as core from 'aws-cdk-lib/core'

import * as path from 'path'

interface Ec2StackPros extends StackProps {
    region: string,
    accountId: string,
    accountName: string,
    envName: string,
}

export class Ec2InstanceStack extends Stack {
    constructor(scope: Construct, id: string, props: Ec2StackPros) {
        const { region, accountId, accountName } = props
        const updatedProps = {
            env: {
                region: region,
                account: accountId,
            },
            ...props
        }
        super(scope, id, updatedProps)

        const vpc = ec2.Vpc.fromLookup(this, 'vpc', {
            vpcName: `vpc-${accountName}`
        })

        const sgEc2 = new ec2.SecurityGroup(this, 'ec2-sg', {
            vpc: vpc,
            description: 'security group for vpc endpoints'
        })

        sgEc2.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'https within the vpc')

        const sgEFS = new ec2.SecurityGroup(this, 'ec2-efs', {
            vpc: vpc,
            description: 'security group for vpc endpoints'
        })

        sgEFS.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049), 'data within the vpc')

        const accessEFSPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticfilesystem:DescribeMountTargets',
                        'elasticfilesystem:ClientMount',
                        'elasticfilesystem:ClientWrite'
                    ],
                    resources: ['*'],
                })
            ]

        })

        const role = new iam.Role(
            this,
            'simple-instance-role', // this is a unique id that will represent this resource in a Cloudformation template
            {
                assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                ],
                inlinePolicies: {
                    'listS3': accessEFSPolicy
                }
            }
        )

        const efsFileSystem = new efs.FileSystem(this, 'efsFileSystem', {
            vpc: vpc,
            encrypted: true, // file system is not encrypted by default
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, // default
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            },
            securityGroup: sgEFS,
        })
        efsFileSystem.addAccessPoint('accesspoint')
        efsFileSystem.applyRemovalPolicy( core.RemovalPolicy.DESTROY )

        const Ec2Instance = new ec2.Instance(this, 'simple ec2', {
            vpc: vpc,
            role: role,
            securityGroup: sgEc2,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            },

            instanceName: 'test instance',
            instanceType: ec2.InstanceType.of( // t2.micro has free tier usage in aws
                ec2.InstanceClass.T2,
                ec2.InstanceSize.MICRO
            ),
            machineImage: ec2.MachineImage.latestAmazonLinux2({
            }),
        })

        Ec2Instance.node.addDependency(efsFileSystem)

        const asset = new assets.Asset(this, 'S3Assets', {
            path: path.join(__dirname, '..', 'assets'),
        });
        asset.grantRead(role)

        Ec2Instance.userData.addCommands(
            `/usr/bin/aws --region ap-southeast-2 s3 cp ${asset.s3ObjectUrl} /root/cfn/assets.zip`,
            `unzip /root/cfn/assets.zip -d /root/cfn/`,
            `/root/cfn/initilize.sh ${efsFileSystem.fileSystemId}`
        )

        new CfnOutput(this, `${this.stackName}-ec2`, {
            value: Ec2Instance.instanceId,
            exportName: `${this.stackName}-ec2`
        })
        new CfnOutput(this, `efs`, {
            value: efsFileSystem.fileSystemId,
            exportName: `${this.stackName}-efs-id`
        })
    }
}