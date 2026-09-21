from fastapi.testclient import TestClient
from api.main import app


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
