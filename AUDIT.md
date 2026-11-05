# Action Importer functional audit

Follow-up: inline Brand and Categories selectors were added to product cards.
The admin `meta.children` category mapping is now fixed. The card interaction
test passes; the original audit suite now reports 10 passing and 8 failing
checks. The remaining failures below are unresolved. Repository-wide lint
reports 2517 errors and 215 warnings across the repository; it is not clean.
The original audit results below describe the state before this follow-up.

Date: 2026-11-05. Scope: the Chrome extension and its integration contract with this admin repository.

The extension is not ready to consider fully verified. Offline checks reproduced nine issues. No application code was changed and no live backend writes were made.

## Verification

Run from the admin repository with Node 24 and the existing installed `jsdom` dependency:

```powershell
node --test --test-isolation=none tests/action-importer-audit.test.mjs
```

Result: 18 checks, 9 pass, 9 fail. The failures deliberately express expected behavior and remain unresolved. The harness executes real model, payload, spreadsheet and scraper functions; application workflow checks execute the actual functions with mocked browser storage and network boundaries. All 11 extension JavaScript files parse and the manifest is valid JSON. Syntax checks do not establish Chrome API compatibility.

## Findings, in priority order

1. **High: changing environment during an operation sends requests to the wrong backend.** `app/app.js:133`, `:244`, `:255`, `:470`. Upload bookkeeping captures the original environment, but the request reads the current environment after awaiting the image download. Reproduction: start in production, pause the download, switch to staging, resume; the upload goes to staging while its ID is recorded under production. Saving has the same mutable request context. Freeze base URL, token and environment for each job and prevent switching while it runs.

2. **High: child categories disappear.** `shared/model.js:297`. The admin tree explicitly uses `meta.children` (`components/lookups/categories.vue:7`); the importer only reads top-level child properties. A root with one nested child becomes a root-only tree. Read the admin nesting recursively and preserve parent relationships.

3. **High integration mismatch: images go to a different field from the admin.** `shared/model.js:118`, `app/payload.js:124`. The default fills `mediaCollective`, leaving `media.cover` empty. The admin edits `item.media.cover` and `item.media.gallery` (`pages/Products/Index.vue:600`). This payload discrepancy is confirmed; whether the backend accepts `mediaCollective` as an alias remains unverified. Align with the admin write contract, then verify saved images through a fresh GET.

4. **High: updates proceed after failing to fetch the current product.** `app/app.js:305`. A GET returning 503 is followed by PUT using cached data or the template. That can overwrite newer backend changes and unrelated fields. Abort updates on failed reads; distinguish an intentional recreation after 404 from temporary failures.

5. **High: a successful create response without a recognized ID permits another create.** `app/app.js:318`. A mocked `{success:true}` response records `savedAt` with a null product ID; saving twice sends two POSTs. The UI warns but does not prevent duplication. Treat this as an unresolved server result and reconcile identity before retrying.

6. **Medium: Excel restoration loses product identity.** `app/excel.js:180`. Export includes local ID, source product ID and backend product ID, but import into empty storage discards these and initializes `backend: {}`. Saving creates another product; subsequent scraping can create another local item because the source ID was lost too. Define an environment-aware restore/link policy rather than blindly trusting IDs from any environment. JSON backup is the existing full-state transfer path; Excel is not currently a safe substitute.

7. **Medium: removing all images does not clear saved images.** `app/payload.js:124`. Image fields are only updated when at least one uploaded image remains. With an empty image list, old cover/gallery entries survive in the update payload. Distinguish intentional removal from an incomplete upload, and send empty arrays for removal.

8. **Medium: query-based product URLs collide.** `shared/model.js:157`. Without a source product ID, `/product?id=1` and `/product?id=2` produce the same local key because all query parameters are removed. One product overwrites the other. Preserve identity-bearing parameters while stripping known tracking parameters; apply the same rule to listing markers and spreadsheet matching.

9. **Medium: foreign-currency prices are silently relabeled.** `shared/model.js:243`, `app/payload.js:37`. A generic source price of USD 25 becomes JOD 25 under the defaults, with no validation error or conversion. This matters for added source shops. Reject mismatched currencies or require an explicit conversion policy.

## Functionality coverage

| Functionality | Evidence and remaining limits |
| --- | --- |
| Login | Phone normalization and access-token storage pass with a mocked response; real authentication and role authorization untested. |
| Brands | Admin `value`/`text` lookup shape passes. |
| Categories | Nested admin shape fails as described above. |
| Magento scraping | Fixture checks pass for Arabic digits, name, SKU, source ID, stock and gallery. Current live shop markup untested. |
| Generic scraping | JSON-LD fixture and HTML cleaning pass; arbitrary shops are not guaranteed. |
| Arabic/English | Mock alternate Magento view passes. Alternate-view requests are not validated against source identity; one failure also suppresses future alternate attempts for that host in the current content-script instance. |
| Reimport | Price history and manually edited price preservation pass. Concurrent panel/background storage updates are not serialized through one shared writer. |
| Product payload | Basic names, brand/categories, unpublished default, stock, offer and simple variance pass. |
| Images | Direct/wrapped response parsing passes. Field mismatch, environment switching and full removal fail. Chrome host permissions, redirects and actual upload responses need browser verification. |
| Save/update | Mocked failure paths expose duplicate-create and stale-update issues. Real backend schema acceptance untested. |
| Excel/CSV | Arabic text and numeric XLSX round-trip and quoted CSV cells pass. Restoring backend identity fails. Blank cells cannot clear existing values under the current documented import policy. |
| Bulk imports | Code inspected: current listing cards only, sequential fetches and stop between products; no pagination traversal. Real Chrome interaction untested. |
| Extra source sites | Registration/permission code inspected; actual permission prompts and injection untested. |
| Backup/restore | Code inspected, not exercised in Chrome. Restore retains backend IDs but does not re-register custom source scripts immediately. |
| Specs/options/videos | Collected locally, but not mapped into backend attributes, configurable variants or video media. Options are explicitly reference-only in the scraper. |

## Remaining live verification

Load the unpacked extension in Chrome and use a staging account to verify login, nested lookup data, one Arabic/English product, image upload, create, read-back, update, image removal, bulk stop/retry, and restart persistence. Confirm staging routing, token permissions and exact create/upload response shapes. Browser host permissions, service-worker lifecycle and current source-site markup cannot be established by the offline suite. Production readiness should not be inferred from the passing fixture checks.

## Follow-up: exact product-page save contract

Traced `pages/Products/Index.vue` through `components/media.vue`, the installed `vuetify-customized-fields/src/components/Upload.vue` used by `<vc-upload>`, and `components/crud.vue`. The separate local `components/upload.vue` is not the uploader referenced by the product media editor.

1. `<vc-upload>` posts multipart data with field `file` to `/v1/upload-media`. Its success handler reads **`resp.file`**, replacing the local file name with that returned path. An upload does not require a persistent media ID.
2. `components/media.vue:205` wraps each returned path with the media defaults. It sets both `src` and `preview` to that path. The defaults are `mediaId: null`, `alt: null`, `type: 'image'`, `youtubeUrl: null`, `publishedAt: null`, `unPublishedAt: null`, and `isPublished: true`. It also adds a temporary UI identifier.
3. The chosen collection determines whether this object is stored in `product.media.cover` or `product.media.gallery`. The admin does not automatically choose the first uploaded image as the cover; that is an importer policy.
4. `simpleProductMapper` copies product name, slug, brand, SKU, metadata, publication fields and stocks into a single variance for simple/virtual products. It does not move product images into `mediaCollective`.
5. `components/crud.vue` sends the resulting product as JSON via POST `/v1/admin/products?trans=off`, or PUT `/v1/admin/products/{id}?trans=off` for updates.
6. API failures are read from `response.data`, including `message`, `details`, and `errors` for validation. The importer already preserves error bodies and displays response JSON, but its save flow currently continues after image-upload failure. For a strict upload-then-save flow, stop before posting the product when a required image fails and keep the original error response available for retry.

Illustrative image entry built from an upload response `{ "file": "returned/path.jpg" }`:

```json
{
  "mediaId": null,
  "src": "returned/path.jpg",
  "preview": "returned/path.jpg",
  "type": "image",
  "alt": null,
  "youtubeUrl": null,
  "isPublished": true,
  "publishedAt": null,
  "unPublishedAt": null
}
```

This is a code-derived contract, not a captured live response. In the current extension, `background.js` receives scraped products and stores them locally; uploads and backend saves run in `app/app.js`. They are not currently background service-worker jobs.
