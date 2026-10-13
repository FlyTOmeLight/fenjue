"""Local gold verifier; benchmark answers/tests are never sent to the model."""
import ast
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile


def verify(request):
    answer, gold = request["answer"], request["gold"]
    if request["dataset"] == "cruxeval":
        expected = ast.literal_eval(gold["output"])
        try:
            actual = ast.literal_eval(answer)
        except (ValueError, SyntaxError):
            return {"valid": True, "passed": False, "reason": "invalid-python-literal"}
        return {"valid": True, "passed": actual == expected, "reason": "literal-equality"}
    if request["dataset"] != "humanevalplus":
        raise ValueError("Unknown dataset")
    if sys.platform != "darwin":
        raise RuntimeError("Code verifier currently requires macOS sandbox-exec")
    with tempfile.TemporaryDirectory(prefix="fenjue-gold-verifier-") as directory:
        root = Path(directory).resolve()
        (root / "candidate.py").write_text(answer)
        (root / "tests.py").write_text(gold["test"])
        (root / "run.py").write_text(
            "import candidate, tests\n"
            + "tests.check(getattr(candidate, " + repr(gold["entry_point"]) + "))\n"
            + "print('FENJUE_GOLD_PASSED')\n"
        )
        # A subprocess inherits these restrictions. No network, writes outside
        # its temporary directory, or access to the user's credentials/home.
        quoted = lambda p: json.dumps(str(p))
        profile = "\n".join([
            "(version 1)", "(allow default)", "(deny network*)",
            "(deny file-write*)", "(allow file-write* (subpath " + quoted(root) + "))",
            "(deny file-read* (subpath " + quoted(Path.home()) + "))",
            "(allow file-read-metadata)",
            "(allow file-read* (subpath " + quoted(Path(sys.prefix).resolve()) + ") (subpath " + quoted(root) + "))",
        ])
        (root / "sandbox.sb").write_text(profile)
        def limits():
            resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
            resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
        try:
            result = subprocess.run(
                ["/usr/bin/sandbox-exec", "-f", str(root / "sandbox.sb"), sys.executable, "-B", str(root / "run.py")],
                cwd=root, env={"PATH": "/usr/bin:/bin", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
                capture_output=True, text=True, timeout=20, preexec_fn=limits,
            )
        except subprocess.TimeoutExpired:
            return {"valid": True, "passed": False, "reason": "execution-timeout"}
        passed = result.returncode == 0 and result.stdout.strip().endswith("FENJUE_GOLD_PASSED")
        infrastructure = "sandbox-exec:" in result.stderr or "sandbox_init:" in result.stderr or "No module named 'numpy'" in result.stderr
        return {"valid": not infrastructure, "passed": passed,
                "reason": "official-tests" if passed else "execution-failed", "exitCode": result.returncode,
                "detail": result.stderr[-1500:] if not passed else ""}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({"valid": False, "passed": False, "reason": str(error)}))
        sys.exit(2)
