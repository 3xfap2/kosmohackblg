from fastapi.testclient import TestClient
from server.main import app


def test_api_contract_and_invalid_json():
    with TestClient(app) as client:
        result = client.post("/api/runs/create", json={"source": {"ref": "P01_intro"}, "algorithm": "edf-baseline", "goal": "priority"})
        assert result.status_code == 200
        record = result.json()["run"]
        advanced = client.post("/api/runs/advance", json={"run": record, "until_step": 2})
        assert advanced.status_code == 200
        assert advanced.json()["view"]["step"] == 2
        rejected = client.post("/api/runs/event", json={"run": record, "event": []})
        assert rejected.status_code == 200 and rejected.json()["error"]
        assert client.post("/api/runs/event", content="{bad", headers={"Content-Type": "application/json"}).status_code == 422
        assert client.post("/api/runs/view", json={"run": {}}).status_code == 422
        assert client.post("/api/runs/view", json={"run": record}).json()["step"] == 0


def test_api_rejects_oversized_body():
    from fastapi.testclient import TestClient
    from server.main import app, MAX_BODY_BYTES
    r = TestClient(app).post("/api/runs/view", content=b"x" * (MAX_BODY_BYTES + 1), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_api_rejects_unbounded_planner_parameters():
    from fastapi.testclient import TestClient
    from server.main import app
    c = TestClient(app)
    for params in ({"deterministic_limit": 1e9}, {"horizon": 100000}, {"replan_every": 200}):
        r = c.post("/api/runs/create", json={"source": {"ref": "P01_intro"}, "algorithm": "horizon-cpsat", "parameters": params})
        assert r.status_code == 422, (params, r.status_code)


def test_api_rejects_body_without_length():
    """Тело без Content-Length (chunked) не принимается: иначе лимит размера обходится."""
    c = TestClient(app)
    r = c.post("/api/runs/view", content=iter([b'{"run": {}}']), headers={"content-type": "application/json"})
    assert r.status_code == 411


def test_record_secret_required_on_vercel(monkeypatch):
    import pytest
    from core import service
    monkeypatch.delenv("SOZVEZDIE_RECORD_SECRET", raising=False)
    monkeypatch.setenv("VERCEL", "1")
    with pytest.raises(RuntimeError, match="SOZVEZDIE_RECORD_SECRET"):
        service._record_secret()
    monkeypatch.setenv("SOZVEZDIE_RECORD_SECRET", "abc")
    assert service._record_secret() == b"abc"
    monkeypatch.delenv("VERCEL")
    monkeypatch.delenv("SOZVEZDIE_RECORD_SECRET")
    assert service._record_secret() not in (b"", b"sozvezdie-dev-secret")
