---
"@kippu/api": minor
---

Image upload for event documents (`T-026-06`). `metadata.images.upload` takes an event the organiser owns, a media type — `image/jpeg`, `image/png` or `image/webp` — and the image as base64, at most 2 MiB decoded, and answers `{ url, mediaType, size }`: the URL at the metadata origin, named by the image's content, that the event's document references it by. A disallowed type, an oversized image, or bytes that are not the declared type are a `BAD_REQUEST`; another organiser's event is refused with `ERR-NotOwner`.
