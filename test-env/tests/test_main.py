import sys
sys.path.insert(0, "../src")
from main import add, multiply


def test_add():
    assert add(2, 3) == 5


def test_multiply():
    assert multiply(4, 5) == 20
