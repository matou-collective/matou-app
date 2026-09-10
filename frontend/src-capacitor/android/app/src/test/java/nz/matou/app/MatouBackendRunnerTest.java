package nz.matou.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * JVM unit test for the identity-encryption-key seam (#117 / #389 / #443). It
 * exercises the generate-once / read-back / migrate logic through in-memory
 * KeyBackings, so no Android Keystore is needed — the on-device
 * EncryptedSharedPreferences backings in {@link MatouBackendRunner} are thin
 * adapters over the same interface. Runs in CI via
 * `gradlew testDebugUnitTest` (.forgejo/workflows/android.yml).
 */
public class MatouBackendRunnerTest {

    private static final String KEY = MatouBackendRunner.IDENTITY_KEY_NAME;

    /** In-memory stand-in for an EncryptedSharedPreferences-backed store. */
    private static final class MapBacking implements MatouBackendRunner.KeyBacking {
        final Map<String, String> store = new HashMap<>();
        int writes = 0;
        int removes = 0;

        @Override
        public String get(String name) {
            return store.get(name);
        }

        @Override
        public void put(String name, String value) {
            writes++;
            store.put(name, value);
        }

        @Override
        public void remove(String name) {
            removes++;
            store.remove(name);
        }
    }

    /** A legacy store with nothing in it — the post-#443 steady state. */
    private static MapBacking emptyLegacy() {
        return new MapBacking();
    }

    @Test
    public void generatesKeyOnceAndReadsItBackIdentically() {
        MapBacking backend = new MapBacking();

        // First backend boot generates and persists the key.
        String first = MatouBackendRunner.loadOrCreateIdentityKey(backend, emptyLegacy());
        assertNotNull(first);
        assertEquals("key generated on first launch", 1, backend.writes);

        // The next boot (app relaunch, or a headless push wake after a
        // stop/re-start) reads the identical key back, no new write.
        String second = MatouBackendRunner.loadOrCreateIdentityKey(backend, emptyLegacy());
        assertEquals("key stable across backend boots", first, second);
        assertEquals("no re-generation on later launches", 1, backend.writes);
    }

    @Test
    public void generatedKeyIs32BytesOfHex() {
        MapBacking backend = new MapBacking();
        String key = MatouBackendRunner.loadOrCreateIdentityKey(backend, emptyLegacy());
        assertEquals("32 bytes → 64 hex chars", 64, key.length());
        assertTrue("hex only", key.matches("[0-9a-f]+"));
        assertEquals("persisted verbatim", key, backend.store.get(KEY));
    }

    @Test
    public void distinctInstallsGetDistinctKeys() {
        String a = MatouBackendRunner.loadOrCreateIdentityKey(new MapBacking(), emptyLegacy());
        String b = MatouBackendRunner.loadOrCreateIdentityKey(new MapBacking(), emptyLegacy());
        assertNotEquals("each install generates its own key", a, b);
    }

    @Test
    public void keyThatCannotBePersistedIsNeverReturned() {
        // Encrypting identity.json with a key that was not persisted would make
        // it unreadable on the next boot, so a failed put must propagate (the
        // runner then falls back to the empty-key legacy path) rather than
        // hand back a fresh key.
        MatouBackendRunner.KeyBacking failing = new MatouBackendRunner.KeyBacking() {
            @Override
            public String get(String name) {
                return null;
            }

            @Override
            public void put(String name, String value) {
                throw new IllegalStateException("disk full");
            }

            @Override
            public void remove(String name) {
            }
        };
        try {
            MatouBackendRunner.loadOrCreateIdentityKey(failing, emptyLegacy());
            fail("expected the persistence failure to propagate");
        } catch (IllegalStateException e) {
            assertEquals("disk full", e.getMessage());
        }
    }

    @Test
    public void emptyStoredValueIsTreatedAsAbsent() {
        MapBacking backend = new MapBacking();
        backend.store.put(KEY, "");
        String key = MatouBackendRunner.loadOrCreateIdentityKey(backend, emptyLegacy());
        assertEquals(64, key.length());
        assertEquals("empty value replaced by a real key", 1, backend.writes);
    }

    // --- #443: the key is isolated from the JS-reachable SecureStorage store ---

    @Test
    public void legacyKeyIsMigratedIntoTheBackendStoreAndVacated() {
        // An install from before #443 holds the key in the WebView-reachable
        // matou_secure store. First boot after update: move it, keep the value.
        MapBacking backend = new MapBacking();
        MapBacking legacy = new MapBacking();
        String original = "ab".repeat(32);
        legacy.store.put(KEY, original);

        String key = MatouBackendRunner.loadOrCreateIdentityKey(backend, legacy);

        assertEquals("identity.json keeps decrypting with the same key", original, key);
        assertEquals("now in the isolated store", original, backend.store.get(KEY));
        assertNull("JS-reachable copy vacated: SecureStorage.getItem returns null", legacy.store.get(KEY));
        assertEquals(1, backend.writes);
        assertEquals(1, legacy.removes);

        // Steady state: later boots read the backend store, never touch legacy.
        assertEquals(original, MatouBackendRunner.loadOrCreateIdentityKey(backend, legacy));
        assertEquals(1, backend.writes);
    }

    @Test
    public void backendStoreWinsWhenBothHoldAKey() {
        MapBacking backend = new MapBacking();
        MapBacking legacy = new MapBacking();
        backend.store.put(KEY, "11".repeat(32));
        legacy.store.put(KEY, "22".repeat(32));

        assertEquals("11".repeat(32), MatouBackendRunner.loadOrCreateIdentityKey(backend, legacy));
        assertEquals("legacy copy untouched", "22".repeat(32), legacy.store.get(KEY));
        assertEquals(0, backend.writes);
    }

    @Test
    public void migrationWriteFailureStillReturnsTheLegacyKeyAndKeepsIt() {
        // If the isolated store cannot be written, the returned value must be
        // unchanged (identity.json still decrypts this boot) and the legacy
        // copy must survive so the migration is retried next boot.
        MapBacking legacy = new MapBacking();
        String original = "cd".repeat(32);
        legacy.store.put(KEY, original);
        MatouBackendRunner.KeyBacking failingBackend = new MatouBackendRunner.KeyBacking() {
            @Override
            public String get(String name) {
                return null;
            }

            @Override
            public void put(String name, String value) {
                throw new IllegalStateException("write failed");
            }

            @Override
            public void remove(String name) {
            }
        };

        assertEquals(original, MatouBackendRunner.loadOrCreateIdentityKey(failingBackend, legacy));
        assertEquals("legacy copy retained for retry", original, legacy.store.get(KEY));
        assertEquals(0, legacy.removes);
    }

    @Test
    public void legacyReadFaultNeverMintsAFreshKey() {
        // A secure-storage fault reading the legacy store is inconclusive: an
        // encrypted identity.json may exist. Minting a fresh key would orphan
        // it, so the fault propagates (runner → legacy plaintext path).
        MapBacking backend = new MapBacking();
        MatouBackendRunner.KeyBacking faultyLegacy = new MatouBackendRunner.KeyBacking() {
            @Override
            public String get(String name) {
                throw new IllegalStateException("keystore unavailable");
            }

            @Override
            public void put(String name, String value) {
            }

            @Override
            public void remove(String name) {
            }
        };
        try {
            MatouBackendRunner.loadOrCreateIdentityKey(backend, faultyLegacy);
            fail("expected the legacy read fault to propagate");
        } catch (IllegalStateException e) {
            assertEquals("keystore unavailable", e.getMessage());
        }
        assertEquals("no fresh key minted", 0, backend.writes);
        assertFalse(backend.store.containsKey(KEY));
    }
}
