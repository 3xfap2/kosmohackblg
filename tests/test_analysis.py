import copy
from core.analysis import impossibility
from test_planner import tiny


def test_contact_union_counts_steps_not_satellites():
    s = tiny()
    other = copy.deepcopy(s["satellites"][0])
    other["id"] = "T"
    s["satellites"].append(other)
    s["environment"]["T"] = copy.deepcopy(s["environment"]["S"])
    for env in s["environment"].values():
        env["relay_available"] = [True, False, False]
    j = s["jobs"][0]
    j["eligible_satellites"].append("T")
    assert impossibility(s, j)["code"] == "insufficient_contact_steps"


def test_energy_bound_is_optimistic_and_explicit():
    s = tiny()
    s["satellites"][0]["initial_soc_pct"] = 0
    assert impossibility(s, s["jobs"][0])["code"] == "energy_bound"
    s["environment"]["S"]["solar_w"] = [60, 60, 60]
    assert impossibility(s, s["jobs"][0]) is None


def test_outage_proof():
    s = tiny()
    s["failures"] = [{"satellite_id": "S", "start_step": 0, "end_step": 3}]
    assert impossibility(s, s["jobs"][0])["code"] == "satellite_unavailable"
