"""Ошибки, переводимые API в понятные ответы."""


class InputError(ValueError):
    pass


class NotFound(LookupError):
    pass
