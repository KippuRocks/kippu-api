---
"@kippurocks/api": patch
---

`clientExtensionResults` in WebAuthn credential inputs is typed as `object`, so the responses browser helpers such as `@simplewebauthn/browser` return are accepted as they come.
