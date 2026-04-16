# Python SDK Example

Minimal Python wrapper for AtlaSent's execution-time authorization API. No external dependencies — uses only the standard library.

## Usage

```python
from atlasent import AtlaSent

gate = AtlaSent(api_key="your-api-key")

# Option 1: Context manager (recommended)
with gate.authorize(
    action_type="validated_system.write",
    actor_id="agent:my-agent",
    context={
        "environment": "production",
        "regulation": "21-cfr-part-11",
        "system_validation_status": "validated",
        "approvals": 2,
        "change_window": True,
    }
) as permit:
    # This code only runs if the action is authorized
    write_to_validated_system(record)

# Option 2: Manual evaluate + verify
permit = gate.evaluate(
    action_type="validated_system.write",
    actor_id="agent:my-agent",
    context={...}
)

gate.verify(
    permit_token=permit.token,
    action_type="validated_system.write",
    actor_id="agent:my-agent",
    context={...}
)

# Proceed with action
```

## Error Handling

```python
from atlasent import AtlaSent, AtlaSentError

gate = AtlaSent(api_key="your-api-key")

try:
    with gate.authorize(...) as permit:
        do_the_thing()
except AtlaSentError as e:
    print(f"Blocked: {e.decision} — {e.reason}")
    # Log, alert, or escalate as required by your SOP
```

## Configuration

| Parameter | Environment Variable | Default |
|-----------|---------------------|---------|
| `api_key` | `ATLASENT_API_KEY` | — |
| `base_url` | `ATLASENT_BASE_URL` | `https://api.atlasent.io/functions/v1` |
