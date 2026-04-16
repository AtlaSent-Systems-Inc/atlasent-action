# LangChain Integration Example

Authorize LangChain agent actions through AtlaSent before execution.

## Usage

```python
from atlasent import AtlaSent
from langchain.tools import BaseTool


class AtlaSentAuthorizedTool(BaseTool):
    """Wraps any LangChain tool with AtlaSent execution-time authorization."""

    name: str = "atlasent_authorized_tool"
    description: str = "A tool that requires authorization before execution"

    def __init__(self, wrapped_tool, gate, action_type, context, **kwargs):
        super().__init__(**kwargs)
        self._wrapped_tool = wrapped_tool
        self._gate = gate
        self._action_type = action_type
        self._context = context
        self.name = wrapped_tool.name
        self.description = wrapped_tool.description

    def _run(self, *args, **kwargs):
        with self._gate.authorize(
            action_type=self._action_type,
            actor_id=f"agent:langchain:{self.name}",
            context=self._context,
        ):
            return self._wrapped_tool._run(*args, **kwargs)


# Setup
gate = AtlaSent(api_key="your-api-key")

context = {
    "environment": "production",
    "regulation": "21-cfr-part-11",
    "system_validation_status": "validated",
    "approvals": 2,
    "change_window": True,
}

# Wrap your existing tool
authorized_tool = AtlaSentAuthorizedTool(
    wrapped_tool=your_existing_tool,
    gate=gate,
    action_type="validated_system.write",
    context=context,
)

# Use in your agent as normal — authorization happens transparently
agent = initialize_agent(tools=[authorized_tool], llm=llm)
```

## How It Works

1. The agent selects a tool as normal
2. Before the tool executes, AtlaSent evaluates the action against your policy
3. If authorized, a single-use permit is issued and verified at execution time
4. The tool runs only after verification succeeds
5. If denied, an `AtlaSentError` is raised — the agent can handle it or escalate

## Dependencies

- `atlasent.py` from the [`python-sdk`](../python-sdk/) example
- `langchain`
