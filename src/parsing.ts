import type {
    BIP32Path,
    Certificate,
    InputTypeUTxO,
    MultiHostNameRelay,
    Network,
    PoolMetadataParams,
    PoolOwnerParams,
    PoolParams,
    RelayParams,
    SingleHostIPRelay,
    SingleHostNameRelay,
    TxOutputTypeAddress,
    TxOutputTypeAddressParams,
    Withdrawal,
} from "./Ada";
// TODO: remove this dependency
import { serializeOutputBasicParams } from "./cardano";
import { TxErrors } from "./txErrors";
import utils, { MAX_LOVELACE_SUPPLY_STR, Precondition } from "./utils";
import { hex_to_buf } from "./utils";

export enum AddressTypeNibble {
    BASE = 0b0000,
    POINTER = 0b0100,
    ENTERPRISE = 0b0110,
    BYRON = 0b1000,
    REWARD = 0b1110,
}

export enum CertificateType {
    STAKE_REGISTRATION = 0,
    STAKE_DEREGISTRATION = 1,
    STAKE_DELEGATION = 2,
    STAKE_POOL_REGISTRATION = 3,
}

export const KEY_HASH_LENGTH = 28;
export const TX_HASH_LENGTH = 32;

const TOKEN_POLICY_LENGTH = 28;
const TOKEN_NAME_LENGTH = 32;

const ASSET_GROUPS_MAX = 1000;
const TOKENS_IN_GROUP_MAX = 1000;

const POOL_REGISTRATION_OWNERS_MAX = 1000;
const POOL_REGISTRATION_RELAYS_MAX = 1000;

export type ParsedCertificate = {
    type: CertificateType.STAKE_REGISTRATION
    path: ValidBIP32Path
} | {
    type: CertificateType.STAKE_DEREGISTRATION
    path: ValidBIP32Path
} | {
    type: CertificateType.STAKE_DELEGATION
    path: ValidBIP32Path
    poolKeyHashHex: FixlenHexString<typeof KEY_HASH_LENGTH>
} | {
    type: CertificateType.STAKE_POOL_REGISTRATION
    pool: ParsedPoolParams
}

function parseCertificate(cert: Certificate): ParsedCertificate {
    switch (cert.type) {
        case CertificateType.STAKE_REGISTRATION:
        case CertificateType.STAKE_DEREGISTRATION: {
            Precondition.checkIsValidPath(
                cert.path,
                TxErrors.CERTIFICATE_MISSING_PATH
            );
            Precondition.check(
                cert.poolKeyHashHex == null,
                TxErrors.CERTIFICATE_SUPERFLUOUS_POOL_KEY_HASH
            );
            return {
                type: cert.type,
                path: parseBIP32Path(cert.path, TxErrors.CERTIFICATE_MISSING_PATH)
            }
        }
        case CertificateType.STAKE_DELEGATION: {
            Precondition.checkIsValidPath(
                cert.path,
                TxErrors.CERTIFICATE_MISSING_PATH
            );
            Precondition.checkIsHexStringOfLength(
                cert.poolKeyHashHex,
                KEY_HASH_LENGTH,
                TxErrors.CERTIFICATE_MISSING_POOL_KEY_HASH
            );
            return {
                type: cert.type,
                path: parseBIP32Path(cert.path, TxErrors.CERTIFICATE_MISSING_PATH),
                poolKeyHashHex: parseHexStringOfLength(cert.poolKeyHashHex!, KEY_HASH_LENGTH, TxErrors.CERTIFICATE_MISSING_POOL_KEY_HASH)
            }
        }
        case CertificateType.STAKE_POOL_REGISTRATION: {
            return {
                type: cert.type,
                pool: parsePoolParams(cert.poolRegistrationParams!)
            }
        }

        default:
            throw new Error(TxErrors.CERTIFICATE_INVALID);
    }
}

export function parseCertificates(certificates: Array<Certificate>): Array<ParsedCertificate> {
    Precondition.checkIsArray(certificates, TxErrors.CERTIFICATES_NOT_ARRAY);

    const parsed = certificates.map(cert => parseCertificate(cert))

    // Pool registration certificate is not allowed to be combined with anything else
    Precondition.check(
        parsed.every((cert) => cert.type !== CertificateType.STAKE_POOL_REGISTRATION) || parsed.length === 1,
        TxErrors.CERTIFICATES_COMBINATION_FORBIDDEN
    );
    return parsed
}

export function validateTransaction(
    network: Network,
    inputs: Array<InputTypeUTxO>,
    outputs: Array<TxOutputTypeAddress | TxOutputTypeAddressParams>,
    feeStr: string,
    ttlStr: string | null,
    certificates: Array<Certificate>,
    withdrawals: Array<Withdrawal>,
    metadataHashHex?: string | null,
    validityIntervalStartStr?: string | null
) {
    Precondition.checkIsArray(certificates, TxErrors.CERTIFICATES_NOT_ARRAY);
    const isSigningPoolRegistrationAsOwner = certificates.some(
        (cert) => cert.type === CertificateType.STAKE_POOL_REGISTRATION
    );

    // inputs
    Precondition.checkIsArray(inputs, TxErrors.INPUTS_NOT_ARRAY);
    for (const input of inputs) {
        Precondition.checkIsHexStringOfLength(
            input.txHashHex,
            TX_HASH_LENGTH,
            TxErrors.INPUT_INVALID_TX_HASH
        );

        if (isSigningPoolRegistrationAsOwner) {
            // input should not be given with a path
            // the path is not used, but we check just to avoid potential confusion of developers using this
            Precondition.check(!input.path, TxErrors.INPUT_WITH_PATH);
        }
    }

    // outputs
    Precondition.checkIsArray(outputs, TxErrors.OUTPUTS_NOT_ARRAY);
    for (const output of outputs) {
        // we try to serialize the data, an error is thrown if ada amount or address params are invalid
        serializeOutputBasicParams(output, network);

        if ("spendingPath" in output && output.spendingPath != null) {
            Precondition.check(
                !isSigningPoolRegistrationAsOwner,
                TxErrors.OUTPUT_WITH_PATH
            );
        }

        if (output.tokenBundle) {
            Precondition.checkIsArray(
                output.tokenBundle,
                TxErrors.OUTPUT_INVALID_TOKEN_BUNDLE
            );
            Precondition.check(output.tokenBundle.length <= ASSET_GROUPS_MAX);

            for (const assetGroup of output.tokenBundle) {
                Precondition.checkIsHexStringOfLength(
                    assetGroup.policyIdHex,
                    TOKEN_POLICY_LENGTH,
                    TxErrors.OUTPUT_INVALID_TOKEN_POLICY
                );

                Precondition.checkIsArray(assetGroup.tokens);
                Precondition.check(assetGroup.tokens.length <= TOKENS_IN_GROUP_MAX);

                for (const token of assetGroup.tokens) {
                    Precondition.checkIsHexString(
                        token.assetNameHex,
                        TxErrors.OUTPUT_INVALID_ASSET_NAME
                    );
                    Precondition.check(
                        token.assetNameHex.length <= TOKEN_NAME_LENGTH * 2,
                        TxErrors.OUTPUT_INVALID_ASSET_NAME
                    );
                    Precondition.checkIsUint64Str(token.amountStr);
                }
            }
        }
    }

    // fee
    Precondition.checkIsValidAdaAmount(feeStr, TxErrors.FEE_INVALID);

    //  ttl
    if (ttlStr != null) {
        Precondition.checkIsPositiveUint64Str(ttlStr, TxErrors.TTL_INVALID);
    }

    // certificates
    parseCertificates(certificates);

    // withdrawals
    Precondition.checkIsArray(withdrawals, TxErrors.WITHDRAWALS_NOT_ARRAY);
    if (isSigningPoolRegistrationAsOwner && withdrawals.length > 0) {
        throw new Error(TxErrors.WITHDRAWALS_FORBIDDEN);
    }
    for (const withdrawal of withdrawals) {
        Precondition.checkIsValidAdaAmount(withdrawal.amountStr);
        Precondition.checkIsValidPath(withdrawal.path);
    }

    // metadata could be null
    if (metadataHashHex != null) {
        Precondition.checkIsHexStringOfLength(metadataHashHex, 32, TxErrors.METADATA_INVALID);
    }

    //  validity interval start
    if (validityIntervalStartStr != null) {
        Precondition.checkIsPositiveUint64Str(
            validityIntervalStartStr,
            TxErrors.VALIDITY_INTERVAL_START_INVALID
        );
    }
}



export type VarlenAsciiString = string & { __type: 'ascii' }
export type FixlenHexString<N> = string & { __type: 'hex', __length: N }
export type Uint64_str = string & { __type: 'uint64_t' }
export type ValidBIP32Path = BIP32Path & { __type: 'bip32_path' }

function parseAscii(str: string, err: string): VarlenAsciiString {
    Precondition.checkIsString(str, err);
    Precondition.check(
        str.split("").every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126),
        err
    );
    return str as VarlenAsciiString
}

function parseHexStringOfLength<L extends number>(str: string, length: L, err: string): FixlenHexString<L> {
    Precondition.checkIsHexStringOfLength(str, length, err)
    return str as FixlenHexString<L>
}

function parseUint64_str(str: string, maxValue: string, err: string): Uint64_str {
    Precondition.checkIsValidUintStr(str, maxValue, err);
    return str as Uint64_str
}

export function parseBIP32Path(path: BIP32Path, err: string): ValidBIP32Path {
    Precondition.checkIsValidPath(path, err);
    return path as ValidBIP32Path
}

export type ParsedMargin = {
    numeratorStr: Uint64_str,
    denominatorStr: Uint64_str
}

export function parseMargin(params: PoolParams['margin']): ParsedMargin {
    const marginNumeratorStr = params.numeratorStr;
    const marginDenominatorStr = params.denominatorStr;
    Precondition.checkIsUint64Str(
        marginNumeratorStr,
        TxErrors.CERTIFICATE_POOL_INVALID_MARGIN
    );
    Precondition.checkIsValidPoolMarginDenominator(
        marginDenominatorStr,
        TxErrors.CERTIFICATE_POOL_INVALID_MARGIN_DENOMINATOR
    );
    // given both are valid uint strings, the check below is equivalent to "marginNumerator <= marginDenominator"
    Precondition.checkIsValidUintStr(
        marginNumeratorStr,
        marginDenominatorStr,
        TxErrors.CERTIFICATE_POOL_INVALID_MARGIN
    );
    return {
        numeratorStr: marginNumeratorStr as Uint64_str,
        denominatorStr: marginDenominatorStr as Uint64_str,
    }
}


export type ParsedPoolParams = {
    keyHashHex: FixlenHexString<28>,
    vrfHashHex: FixlenHexString<32>,
    pledgeStr: Uint64_str,
    costStr: Uint64_str,
    margin: ParsedMargin,
    rewardAccountHex: FixlenHexString<29>
    owners: ParsedPoolOwner[],
    relays: ParsedPoolRelay[],
    metadata: ParsedPoolMetadata | null
}


export function parsePoolParams(params: PoolParams): ParsedPoolParams {
    const keyHashHex = parseHexStringOfLength(params.poolKeyHashHex, KEY_HASH_LENGTH, TxErrors.CERTIFICATE_POOL_INVALID_POOL_KEY_HASH)
    const vrfHashHex = parseHexStringOfLength(params.vrfKeyHashHex, 32, TxErrors.CERTIFICATE_POOL_INVALID_VRF_KEY_HASH)
    const pledgeStr = parseUint64_str(params.pledgeStr, MAX_LOVELACE_SUPPLY_STR, TxErrors.CERTIFICATE_POOL_INVALID_PLEDGE)
    const costStr = parseUint64_str(params.costStr, MAX_LOVELACE_SUPPLY_STR, TxErrors.CERTIFICATE_POOL_INVALID_COST)
    const margin = parseMargin(params.margin)
    const rewardAccountHex = parseHexStringOfLength(params.rewardAccountHex, 29, TxErrors.CERTIFICATE_POOL_INVALID_REWARD_ACCOUNT)

    const owners = params.poolOwners.map(owner => parsePoolOwnerParams(owner))
    const relays = params.relays.map(relay => parsePoolRelayParams(relay))
    const metadata = parsePoolMetadataParams(params.metadata)

    // Additional checks
    Precondition.check(
        owners.length <= POOL_REGISTRATION_OWNERS_MAX,
        TxErrors.CERTIFICATE_POOL_OWNERS_TOO_MANY
    );
    Precondition.check(
        relays.length <= POOL_REGISTRATION_RELAYS_MAX,
        TxErrors.CERTIFICATE_POOL_RELAYS_TOO_MANY
    );
    Precondition.check(
        owners.filter(o => o.type === PoolOwnerType.PATH).length === 1,
        TxErrors.CERTIFICATE_POOL_OWNERS_SINGLE_PATH
    )

    return {
        keyHashHex,
        vrfHashHex,
        pledgeStr,
        costStr,
        margin,
        rewardAccountHex,
        owners,
        relays,
        metadata
    }

}

export const enum PoolOwnerType {
    PATH = 1,
    KEY_HASH = 2,
}

export type ParsedPoolOwner = {
    type: PoolOwnerType.PATH,
    path: BIP32Path
} | {
    type: PoolOwnerType.KEY_HASH
    hashHex: FixlenHexString<typeof KEY_HASH_LENGTH>
}

export function parsePoolOwnerParams(params: PoolOwnerParams): ParsedPoolOwner {
    // TODO: should we check if mutually exclusive?
    if (params.stakingPath) {
        const path = parseBIP32Path(params.stakingPath, TxErrors.CERTIFICATE_POOL_OWNER_INVALID_PATH);

        return {
            type: PoolOwnerType.PATH,
            path,
        }
    }

    if (params.stakingKeyHashHex) {
        const hashHex = parseHexStringOfLength(
            params.stakingKeyHashHex,
            KEY_HASH_LENGTH,
            TxErrors.CERTIFICATE_POOL_OWNER_INVALID_KEY_HASH
        );

        return {
            type: PoolOwnerType.KEY_HASH,
            hashHex
        }
    }

    throw new Error(TxErrors.CERTIFICATE_POOL_OWNER_INCOMPLETE);
}

export const enum RelayType {
    SingleHostAddr = 0,
    SingleHostName = 1,
    MultiHostName = 2,
}

export type ParsedPoolRelay = {
    type: RelayType.SingleHostAddr,
    port: number | null,
    ipv4: Buffer | null,
    ipv6: Buffer | null,
} | {
    type: RelayType.SingleHostName,
    port: number | null,
    dnsName: VarlenAsciiString,
} | {
    type: RelayType.MultiHostName,
    dnsName: VarlenAsciiString
}

function parsePort(portNumber: number, err: string): number {
    Precondition.checkIsUint32(portNumber, err)
    Precondition.check(portNumber <= 65535, err)
    return portNumber
}

function parseIPv4(ipv4: string, err: string): Buffer {
    Precondition.checkIsString(ipv4, err);
    const ipParts = ipv4.split(".");
    Precondition.check(ipParts.length === 4, err)

    const ipBytes = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) {
        const ipPart = utils.safe_parseInt(ipParts[i]);
        Precondition.checkIsUint8(ipPart, err)
        ipBytes.writeUInt8(ipPart, i);
    }
    return ipBytes
}

// FIXME(ppershing): This is terrible and wrong implementation
function parseIPv6(ipv6: string, err: string): Buffer {
    Precondition.checkIsString(ipv6, err)
    const ipHex = ipv6.split(":").join("");
    Precondition.checkIsHexStringOfLength(ipHex, 16, err)
    return hex_to_buf(ipHex);
}

function parseDnsName(dnsName: string, err: string): VarlenAsciiString {
    Precondition.checkIsString(dnsName, err);
    Precondition.check(dnsName.length <= 64, err)
    // eslint-disable-next-line no-control-regex
    Precondition.check(/^[\x00-\x7F]*$/.test(dnsName), err)
    Precondition.check(
        dnsName
            .split("")
            .every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126),
        err
    );
    return dnsName as VarlenAsciiString
}

function parsePoolRelayParams(relayParams: RelayParams): ParsedPoolRelay {
    switch (relayParams.type) {
        case RelayType.SingleHostAddr: {
            const params = relayParams.params as SingleHostIPRelay
            return {
                type: RelayType.SingleHostAddr,
                port: ('portNumber' in params && params.portNumber != null)
                    ? parsePort(params.portNumber, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_PORT)
                    : null,
                ipv4: ('ipv4' in params && params.ipv4 != null)
                    ? parseIPv4(params.ipv4, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_IPV4)
                    : null,
                ipv6: ('ipv6' in params && params.ipv6 != null)
                    ? parseIPv6(params.ipv6, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_IPV6)
                    : null,
            }
        }
        case RelayType.SingleHostName: {
            const params = relayParams.params as SingleHostNameRelay

            return {
                type: RelayType.SingleHostName,
                port: ('portNumber' in params && params.portNumber != null)
                    ? parsePort(params.portNumber, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_PORT)
                    : null,
                dnsName: parseDnsName(params.dnsName, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_DNS)
            }
        }
        case RelayType.MultiHostName: {
            const params = relayParams.params as MultiHostNameRelay
            return {
                type: RelayType.MultiHostName,
                dnsName: parseDnsName(params.dnsName, TxErrors.CERTIFICATE_POOL_RELAY_INVALID_DNS)
            }
        }
        default:
            throw new Error(TxErrors.CERTIFICATE_POOL_RELAY_INVALID_TYPE);
    }
}

export type ParsedPoolMetadata = {
    url: VarlenAsciiString,
    hashHex: FixlenHexString<32>,
} & { __brand: 'pool_metadata' }

export function parsePoolMetadataParams(params: PoolMetadataParams | null): ParsedPoolMetadata | null {
    if (params == null) return null

    const url = parseAscii(params.metadataUrl, TxErrors.CERTIFICATE_POOL_METADATA_INVALID_URL);
    // Additional length check
    Precondition.check(
        url.length <= 64,
        TxErrors.CERTIFICATE_POOL_METADATA_INVALID_URL
    );

    const hashHex = parseHexStringOfLength(params.metadataHashHex, 32, TxErrors.CERTIFICATE_POOL_METADATA_INVALID_HASH);

    return {
        url,
        hashHex,
        __brand: 'pool_metadata' as const
    }
}
