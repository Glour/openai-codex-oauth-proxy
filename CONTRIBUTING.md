# Contributing

Thanks for helping improve the proxy.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Never commit OAuth credentials, bearer tokens, `.env` files, or production
  request logs. Use `.env.example` and redacted fixtures instead.
- Keep the proxy deliberately narrow. Compatibility additions should be backed
  by an upstream request or response example and tests.

## Development checks

Run these checks before opening a pull request:

```sh
npm run check
npm test
docker compose -f compose.yml config --quiet
```

## Pull requests

- Make one focused change per pull request.
- Explain the user-facing behavior, compatibility impact, and how it was
  tested.
- Update the README when configuration, supported API fields, or security
  expectations change.
- Add or update tests for behavior changes.

By contributing, you agree that your contribution may be distributed under the
[MIT License](LICENSE).
