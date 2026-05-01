import sys
import yaml

with open("action.yml") as f:
    data = yaml.safe_load(f)

required = ["name", "description", "inputs", "outputs", "runs"]
missing = [k for k in required if k not in data]
if missing:
    print(f"Missing keys: {missing}", file=sys.stderr)
    sys.exit(1)

print("action.yml valid")
