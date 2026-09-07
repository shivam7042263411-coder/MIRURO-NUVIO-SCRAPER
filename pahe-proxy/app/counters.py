class Counters:
    def __init__(self):
        self._store = {}

    def bump(self, key, by=1):
        self._store[key] = self._store.get(key, 0) + by

    def set(self, key, value):
        self._store[key] = value

    def get(self, key, default=0):
        return self._store.get(key, default)

    def snapshot(self):
        return dict(self._store)


counters = Counters()