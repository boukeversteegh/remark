# Release plan

## Scope

The release covers the importer, the new settings page and the billing fix.

- [ ] Bouke (2026-09-06 09:00:00): **Importer timeouts** <!--thread-->
  Large CSV imports time out after 30 s on the staging box. This blocks the pilot customer, so #important and #importer.

  - 🤖 Agent (2026-09-06 09:05:00): Reproduced with a 40 MB file. The parser reads the whole file into memory before the first row is validated; streaming it fixes the timeout. Draft in the branch `import-stream`. #bench

    - Bouke (2026-09-06 09:20:00): #important

  - Alice (2026-09-06 09:30:00): Please keep the old path behind a flag until the pilot signs off.

- [ ] Bouke (2026-09-06 10:00:00): **Settings page copy** <!--thread-->
  The settings page still says "Preferences" in two places. #ui #copy

  - 🤖 Agent (2026-09-06 10:04:00): Fixed both strings; the screenshot is in the PR.

    - Alice (2026-09-06 10:10:00): #ui

## Billing

- [x] Alice (2026-09-06 11:00:00): **Rounding in invoices** <!--thread-->
  Line totals were rounded before summing, so a 12-line invoice could be off by a cent. Fixed in `billing/round.go`; see `#123` in the tracker (not a tag) and the ref #r20260906090000.

  - Bouke (2026-09-06 11:15:00): Verified against last month's invoices. #important #billing

- Bouke (2026-09-06 11:30:00): Next planning session is Thursday; bring the numbers. <!--thread-->
