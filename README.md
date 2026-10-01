# Native file actions experiment

Temporary, public experiment using synthetic files and Electron 39.8.3.
No application source, credentials, user data or production assets are included.

The manual workflow probes native file clipboard representations and recycling on
Windows and macOS. macOS compiles and checks its independent AppKit reader before
installing Electron. Results include exact native errors and environment details.
The full synthetic History harness uses the same standard runners, Node 22,
Electron 39.8.3, Sharp 0.34.5 and Playwright 1.59.1 as the application.
It includes filepath thumbnails at 512 pixels, streamed original preview,
right-click multiselection, two-file clipboard overwritten by a one-file preview
copy, cancellation, real Electron recycling, original-path recycle-bin SHA-256
readback and persisted missing-asset status. Each Sharp differential runs in a
fresh Electron process: no thumbnails, default filepath cache, buffer input,
zero file cache and disabled cache. The unchanged Windows filepath case must
reproduce the exact native failure; all four controls must successfully recycle.

65-file menu tests cover canonical path association, first-page sort, replacing
selection on right-click, removing only a record while preserving all files,
load-more and refresh. macOS also runs the noncanonical temporary-root negative
control. Traces, native errors, cache/stream observations and History are uploaded.
This generic harness contains no private application source and does not certify
the application's implementation or packaged binaries; the private integration
workflow is the final check after this experiment passes.
