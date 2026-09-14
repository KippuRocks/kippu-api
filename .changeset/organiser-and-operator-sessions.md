---
"@kippu/api": minor
---

Organiser and operator authentication, and sessions (`T-020-05`):

- `auth.organiser.beginSignUp` → `completeSignUp` and `auth.organiser.beginSignIn` → `completeSignIn`: explicit WebAuthn exchanges, a challenge with `navigator.credentials` options and then the credential, returning a session.
- `auth.operator.redeemEnrolmentCode`: an operator exchanges a one-time enrolment code for a session.
- `auth.session.current` and `auth.session.signOut`.

A session's `token` is a bearer token for the `Authorization` header.
