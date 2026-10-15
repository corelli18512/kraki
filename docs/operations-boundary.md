# Product and operator tooling

Kraki provides the product's data collection and observability interfaces. An
operator owns the surrounding infrastructure and chooses how to monitor it.

## In this repository

- Relay liveness/readiness and direct-loopback counters/health logs.
- Authenticated foreground activity collection and its storage/migration rules.
- Optional client performance metadata and the independent Monitor receiver.
- Product privacy disclosures, self-hosting documentation and release tooling.

These components do not depend on a personal monitoring repository. Existing
optional integration hooks, such as notifying an installed monitor about planned
relay maintenance, remain optional.

## Managed independently

The maintainer's personal host configurations, account/diagnostic aggregation,
Bark deployment, daily notifications, alert policies and backup scheduling tools
have moved out of the product repository. They have their own tests and deployment
process. They are not required to build or run Kraki and are not automatically
installed or enabled by a product release.

For self-hosting, use your own monitoring and backup solution. Protect metrics
and account data from public access, restrict collector permissions, and preserve
unknown/missing data rather than interpreting it as zero or healthy. Avoid
counting mirrored accounts twice in multi-region deployments.

Removing these operator tools does not remove or narrow any product privacy
disclosure, alter activity collection, or establish that backups or independent
external monitoring have been commissioned.
