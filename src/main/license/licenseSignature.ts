import { verify as verifySignature } from 'node:crypto'
import { canonicalJson } from '../security/securityCanonicalJson'
import { HFM_LICENSE_PUBLIC_KEY_ID, HFM_LICENSE_PUBLIC_KEY_PEM } from '../security/securityPublicKeys'
import type { HfmLicenseDocument } from './licenseTypes'

export function licensePayloadForSignature(license: HfmLicenseDocument): Omit<HfmLicenseDocument, 'signature'> {
  const { signature: _signature, ...payload } = license
  return payload
}

export function verifyLicenseSignature(license: HfmLicenseDocument): boolean {
  if (!license.signature) return false
  try {
    return verifySignature(
      'sha256',
      Buffer.from(canonicalJson(licensePayloadForSignature(license)), 'utf-8'),
      { key: HFM_LICENSE_PUBLIC_KEY_PEM },
      Buffer.from(license.signature, 'base64')
    )
  } catch {
    return false
  }
}

export function licensePublicKeyId(): string {
  return HFM_LICENSE_PUBLIC_KEY_ID
}
