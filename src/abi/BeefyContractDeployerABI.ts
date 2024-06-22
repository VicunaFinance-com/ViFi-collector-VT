export const BeefyContractDeployerABI = [
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'bytes32', name: 'salt', type: 'bytes32' },
            {
                indexed: false,
                internalType: 'address',
                name: 'deploymentAddress',
                type: 'address',
            },
        ],
        name: 'ContractDeployed',
        type: 'event',
    },
    {
        inputs: [
            { internalType: 'uint256', name: '_num', type: 'uint256' },
            { internalType: 'string', name: '_string', type: 'string' },
        ],
        name: 'createSalt',
        outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
        stateMutability: 'pure',
        type: 'function',
    },
    {
        inputs: [
            { internalType: 'bytes32', name: '_salt', type: 'bytes32' },
            { internalType: 'bytes', name: '_bytecode', type: 'bytes' },
        ],
        name: 'deploy',
        outputs: [{ internalType: 'address', name: 'deploymentAddress', type: 'address' }],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { internalType: 'bytes32', name: '_salt', type: 'bytes32' },
            { internalType: 'bytes', name: '_bytecode', type: 'bytes' },
        ],
        name: 'getAddress',
        outputs: [{ internalType: 'address', name: '', type: 'address' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const;
