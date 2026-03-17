def format_result(value: float, precision: int = 2) -> str:
    return f"{value:.{precision}f}"


def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))
