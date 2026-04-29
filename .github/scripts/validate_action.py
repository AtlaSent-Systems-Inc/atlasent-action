import yaml
import sys

with open('action.yml') as f:
    data = yaml.safe_load(f)

required = ['name', 'description', 'inputs', 'outputs', 'runs']
missing = [k for k in required if k not in data]
for k in missing:
    print(f'Missing key: {k}', file=sys.stderr)

if missing:
    sys.exit(1)

print('action.yml valid')
