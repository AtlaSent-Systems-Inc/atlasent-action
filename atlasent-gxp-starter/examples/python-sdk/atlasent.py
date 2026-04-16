"""
AtlaSent Python SDK — Minimal wrapper for execution-time authorization.

Usage:
    from atlasent import AtlaSent

    gate = AtlaSent(api_key="your-api-key")
    with gate.authorize("validated_system.write", actor_id="agent:my-agent", context={...}) as permit:
        # Your agent action here — only runs if authorized
        write_to_validated_system(record)
"""

import json
import os
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError


class AtlaSentError(Exception):
    """Raised when AtlaSent denies an action or encounters an error."""
    def __init__(self, decision, reason, error_code=None):
        self.decision = decision
        self.reason = reason
        self.error_code = error_code
        super().__init__(f"AtlaSent {decision}: {reason}")


class Permit:
    """A single-use execution permit returned by AtlaSent."""
    def __init__(self, token, decision, response):
        self.token = token
        self.decision = decision
        self.raw = response


class AtlaSent:
    """Client for AtlaSent's execution-time authorization API."""

    def __init__(self, api_key=None, base_url=None):
        self.api_key = api_key or os.environ.get("ATLASENT_API_KEY")
        self.base_url = base_url or os.environ.get(
            "ATLASENT_BASE_URL",
            "https://api.atlasent.io/functions/v1"
        )

    def evaluate(self, action_type, actor_id, context, request_id=None):
        """Request authorization for an agent action."""
        request_id = request_id or f"eval-{uuid.uuid4()}"

        body = {
            "action_type": action_type,
            "actor_id": actor_id,
            "request_id": request_id,
            "context": context,
        }

        resp = self._post("/v1-evaluate", body)
        decision = resp.get("decision")

        if decision != "allow":
            raise AtlaSentError(
                decision=decision or "error",
                reason=resp.get("reason", resp.get("deny_reason", "no reason provided")),
                error_code=resp.get("error_code", resp.get("deny_code")),
            )

        token = resp.get("permit_token") or resp.get("permit")
        return Permit(token=token, decision=decision, response=resp)

    def verify(self, permit_token, action_type, actor_id, context, request_id=None):
        """Verify a permit at execution time."""
        request_id = request_id or f"verify-{uuid.uuid4()}"

        body = {
            "permit_token": permit_token,
            "action_type": action_type,
            "actor_id": actor_id,
            "environment": context.get("environment", "production"),
            "request_id": request_id,
            "context": context,
        }

        resp = self._post("/v1-verify-permit", body)
        outcome = resp.get("outcome") or resp.get("decision")
        valid = resp.get("valid")

        if valid is False or outcome != "allow":
            raise AtlaSentError(
                decision=outcome or "error",
                reason=resp.get("reason", resp.get("deny_reason", "unknown")),
                error_code=resp.get("verify_error_code", resp.get("deny_code")),
            )

        return resp

    def authorize(self, action_type, actor_id, context):
        """Context manager that evaluates and verifies in one step.

        Usage:
            with gate.authorize("validated_system.write", ...) as permit:
                do_the_thing()
        """
        return _AuthorizeContext(self, action_type, actor_id, context)

    def _post(self, path, body):
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode()
        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {self.api_key}")

        try:
            with urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            try:
                error_body = json.loads(e.read())
            except Exception:
                error_body = {}
            raise AtlaSentError(
                decision="error",
                reason=error_body.get("reason", f"HTTP {e.code}"),
                error_code=error_body.get("error_code"),
            ) from e


class _AuthorizeContext:
    def __init__(self, client, action_type, actor_id, context):
        self._client = client
        self._action_type = action_type
        self._actor_id = actor_id
        self._context = context
        self.permit = None

    def __enter__(self):
        self.permit = self._client.evaluate(
            self._action_type, self._actor_id, self._context
        )
        self._client.verify(
            self.permit.token, self._action_type, self._actor_id, self._context
        )
        return self.permit

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False
