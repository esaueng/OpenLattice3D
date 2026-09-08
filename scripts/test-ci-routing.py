"""Exercise the immutable workflow policy without starting a runner."""
import copy
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/trusted-ci.yml'


def policy_namespace():
    text = WORKFLOW.read_text()
    script = text.split("python3 - <<'PY_POLICY'\n", 1)[1].split('          PY_POLICY', 1)[0]
    script = '\n'.join(line[10:] if line.startswith('          ') else line for line in script.splitlines())
    scope = {'__name__': 'policy_test'}
    exec(compile(script, str(WORKFLOW), 'exec'), scope)
    return scope


class TrustedPolicyTests(unittest.TestCase):
    def setUp(self):
        self.scope = policy_namespace()
        repo = {'id': self.scope['REPO_ID'], 'full_name': self.scope['REPO'], 'fork': False}
        self.event = {'pull_request': {'number': 7, 'state': 'open',
            'user': {'login': self.scope['ACTOR'], 'id': self.scope['ACTOR_ID']},
            'head': {'repo': copy.deepcopy(repo)}, 'base': {'repo': repo, 'ref': 'main'}}}
        self.context = {'REPOSITORY': self.scope['REPO'], 'REPOSITORY_ID': str(self.scope['REPO_ID']),
            'ACTOR': self.scope['ACTOR'], 'ACTOR_ID': str(self.scope['ACTOR_ID']),
            'TRIGGERING_ACTOR': self.scope['ACTOR'], 'EVENT_NAME': 'pull_request',
            'REF': 'refs/pull/7/merge', 'SHA': 'a' * 40, 'REF_PROTECTED': 'true'}

    def authorized(self):
        return self.scope['authorized'](self.event, self.context)

    def test_owner_pr(self):
        self.assertTrue(self.authorized())

    def test_untrusted_contexts(self):
        for key, value in [('ACTOR', 'outsider'), ('ACTOR_ID', '1'), ('TRIGGERING_ACTOR', 'outsider'),
                           ('REPOSITORY_ID', '1'), ('REPOSITORY', 'example/other'),
                           ('EVENT_NAME', 'pull_request_target'), ('REF', 'refs/pull/7/head'),
                           ('REF', 'refs/pull/8/merge'), ('SHA', '')]:
            with self.subTest(key=key, value=value):
                original = self.context[key]
                self.context[key] = value
                self.assertFalse(self.authorized())
                self.context[key] = original

    def test_untrusted_pr_payloads(self):
        mutations = [lambda pr: pr['head']['repo'].update(fork=True),
                     lambda pr: pr['head']['repo'].update(id=1),
                     lambda pr: pr['head']['repo'].update(full_name='outside/repo'),
                     lambda pr: pr['base'].update(ref='feature'),
                     lambda pr: pr['base']['repo'].update(id=1),
                     lambda pr: pr['user'].update(id=1),
                     lambda pr: pr['user'].update(login='outsider'),
                     lambda pr: pr.update(state='closed'),
                     lambda pr: pr.update(number=True)]
        original = copy.deepcopy(self.event)
        for mutate in mutations:
            self.event = copy.deepcopy(original)
            mutate(self.event['pull_request'])
            self.assertFalse(self.authorized())

    def test_protected_main_only(self):
        for event_name in ['push', 'workflow_dispatch']:
            self.context.update(EVENT_NAME=event_name, REF='refs/heads/main')
            self.assertTrue(self.authorized())
            self.context['REF_PROTECTED'] = 'false'
            self.assertFalse(self.authorized())
            self.context.update(REF_PROTECTED='true', REF='refs/heads/feature')
            self.assertFalse(self.authorized())

    def test_policy_precedes_checkout_and_no_secrets(self):
        text = WORKFLOW.read_text()
        self.assertLess(text.index("python3 - <<'PY_POLICY'"), text.index('actions/checkout@'))
        self.assertNotIn('secrets:', text)
        self.assertNotIn('secrets.', text)
        self.assertIn("vars.CI_FLEET_ENABLED == 'true'", text)
        self.assertRegex(text, r'uses: esaueng/remus/.github/workflows/select-runner.yml@[a-f0-9]{40}')
        self.assertIn('enabled: true', text)
        self.assertIn('"labels":"ci-server-jane"', text)
        self.assertIn('"labels":"ci-server-john"', text)
        self.assertIn('ci-server-jane-1|ci-server-jane-2)', text)
        self.assertIn('test -f', text)

    def test_embedded_shell_syntax(self):
        text = WORKFLOW.read_text()
        for block in re.findall(r'        run: \|\n((?:          [^\n]*\n|\n)+)', text):
            script = '\n'.join(line[10:] if line.startswith('          ') else line for line in block.splitlines())
            result = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
