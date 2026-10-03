// The PickFix item on the Chrome Web Store (Developer Dashboard → Package → View public key).
// Google holds the private key. Unpacked development builds put this public key in their manifest
// `key`, so they get the same id as the store build and pickfix-mcp accepts both.

/** The value of the extension manifest's `key`: base64 DER SubjectPublicKeyInfo. */
export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArf6ZZ/IrExGrX76b2NLKHu30wSJcoEsKmRR9qQ8ZR+ZEZHF+NXdFVYGCDgVJPTGrmf8pW3u0QL9OmwN4zZyuIYAzxQ7xJHnaa0k2IAMQyosUow9sZHdwxwkRsYkE0xdT5dSiQ0bXlUpa6mT/A0at3XHWz1RnZqRL1M+nhtFQJ+N3VBcl59pRt2DHulRShkEu/9uKoklQobT3gqyiKIyCiHwwtuT5gFAJfwRFVFW7YXgangCJPNAnq4JNeiqquKvw75Je6wMaIiZxX3S2VmKS7wxzevN/l0PcLUXVXhG2F7wBIKW6bOuH7Qn50KmnqsgXda6K3qEHVcP61ACDiIJmOwIDAQAB';

/** The Chrome extension id derived from EXTENSION_PUBLIC_KEY: the Chrome Web Store item id. */
export const EXTENSION_ID = 'eehanlcaccamfaalnfcikkdneffjkife';
