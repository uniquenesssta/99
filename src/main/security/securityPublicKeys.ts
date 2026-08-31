import { createHash } from 'node:crypto'

function normalizePublicKeyPem(pem: string): string {
  const normalized = pem.trim().replace(/\r\n/g, '\n')
  if (!normalized.includes('-----BEGIN PUBLIC KEY-----') || !normalized.includes('-----END PUBLIC KEY-----')) {
    throw new Error('Invalid HFM public key PEM. Expected BEGIN/END PUBLIC KEY block.')
  }
  if (normalized.includes('PRIVATE KEY')) {
    throw new Error('Invalid HFM public key PEM. PRIVATE KEY must never be embedded in the app.')
  }
  return `${normalized}\n`
}

function publicKeyId(pem: string): string {
  return createHash('sha256').update(normalizePublicKeyPem(pem)).digest('hex').slice(0, 16)
}

const HFM_INTEGRITY_PUBLIC_KEY_SOURCE = `
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA2vCxvNffMMYY2QeIYe7n
zvoG9vrP45yDsTN0139HU3tp627OLm/15J7TnWubGmrlotU8f7Ikai1dNBRdXc+A
6weFJy2FqnP5iwG8pquwcKBi3AbnS3yHyzK4Lr+AUhk0HUeTrvwtwthL+9SK1syM
YoY1DuOLO9r0fhJ6ZeUt69zEqjcvfLe2rX1eVURvuZqcEfyJGDjM7Yhu+KsAKcff
qvI1P6Dj/Y3xPc8qhEquUjX4W9iGzYG85wb2WPvfShMVl47oUAfmDbrUh4/cmL7A
UFiWTRnFPItLnkA0bpiajuDeeAHmL5ARwkkNd7C5hQpcdjwYdYFm8Shzm+j12No7
Z4ER2vp4UQrQWTFZ6xlojSrY1VVB/SZJgsimzEpo4bd29W1aoRFli/i21tl/y2Ga
p13ccHVC6F2YwR/09Ww0A4MGorUEoAITW1k6bOO0PGrIuxJBuUiWTXzLCo+ID/nZ
tnNjxBabphUdiION6L2nTA+xt/ur69kfuI1NFgSDBKldAgMBAAE=
-----END PUBLIC KEY-----
`

const HFM_LICENSE_PUBLIC_KEY_SOURCE = `
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAvvQ3/vAES2HhxZ9toEM5
62iBa/lWIJzOigc//DhS2RpJuvQAZfv6cAixBIN+Ag4eqnE9KaOhd3T0LYmJfwTD
1J2K/wTrTwuG50rEGWQmTuSxUewsNi+46XWZojOxW0CoTmLG+mahPNMfvFDGKzzn
8r3gW2WcniOZE8an/imNiPWGEOMfsgO64iQtL8qm3JNX7M7KMKbjGMHyU37Mr5Rv
PdU307DiTxekD6AE4T0VG3U2Fq7bydimEtRqhsw4661cieY1xb0vzr3IzTaxJvdL
gCdERviTuAQR/m5SX7xIwHJ0yF/wkKDGN8lC2fUh0Ycd0Sfe39ny7GonAGIfqbs/
65dtSWn4x932jMxQ8tZoHNrc1vcJeca7niTD6nWmoCiSeR7fQL3ixYrVzpx9VoNO
Ge7jCkuG12r0rYMlj+3orpIiN8UuLBq+wuECVp4Xko1rYoY0+Xc7Sbb8VzcXLjkR
/bw3WFNqjWoZReM43QBsXL8eUbeYBRBs4+HujpXry1ptAgMBAAE=
-----END PUBLIC KEY-----
`

export const HFM_INTEGRITY_PUBLIC_KEY_PEM = normalizePublicKeyPem(HFM_INTEGRITY_PUBLIC_KEY_SOURCE)
export const HFM_INTEGRITY_PUBLIC_KEY_ID = publicKeyId(HFM_INTEGRITY_PUBLIC_KEY_PEM)

export const HFM_LICENSE_PUBLIC_KEY_PEM = normalizePublicKeyPem(HFM_LICENSE_PUBLIC_KEY_SOURCE)
export const HFM_LICENSE_PUBLIC_KEY_ID = publicKeyId(HFM_LICENSE_PUBLIC_KEY_PEM)
