# Trajectory Verify Mode — Not Available

`trajectory-verify` is not a supported AtlaSent GitHub Action mode.

The public runtime does not implement `/v1/trajectory-verify`, so workflows must not rely on `trajectory-verify`, `trajectory-permit-id`, `trajectory-step-id`, `trajectory-step-name`, `trajectory-halt-on-deviation`, or the related trajectory outputs. Earlier documentation described this mode before a server-side implementation existed; that was incorrect.

## What to use instead

For production changes, use the shipped authorization boundary:

1. Run the normal AtlaSent `action:` evaluation in `mode: evaluate-only` when you need a separate execution boundary.
2. Pass the returned `permit-token` and `execution-hash` unchanged to a later `verify-permit: true` step immediately before the consequential operation.
3. Gate the protected operation on the verify step's `verified == 'true'` result.
4. Use Change Brief for pre-execution preparation/evidence and the existing consequential-operation evidence path for execution/outcome tracking.

This preserves AtlaSent's actual invariant: authorization is bound to the exact consequential action and re-verified at the execution boundary. It does not create or imply a separate trajectory authorization engine.

Existing workflows that still set trajectory inputs should remove them. The action manifest and remaining cross-repository references are being removed under AtlaSent API issue #2932.
