package nz.matou.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * JVM unit test for the identity-encryption-key seam (#117 / #389). It
 * exercises the generate-once / read-back logic through an in-memory
 * KeyBacking, so no Android Keystore is needed — the on-device
 * EncryptedSharedPreferences backing in {@link MatouBackendRunner} is a thin
 * adapter over the same interface. Runs in CI via
 * `gradlew testDebugUnitTest` (.forgejo/workflows/android.yml).
 */
public class MatouBackendRunnerTest {

    /** In-memory stand-in for the EncryptedSharedPreferences-backed store. */
    private static final class MapBacking implements MatouBackendRunner.KeyBacking {
        final Map<String, String> store = new HashMap<>();
        int writes = 0;

        @Override
        public String get(String name) {
            return store.get(name);
        }

        @Override
        public void put(String name, String value) {
            writes++;
            store.put(name, value);
        }
    }

    @Test
    public void generatesKeyOnceAndReadsItBackIdentically() {
        MapBacking backing = new MapBacking();

        // First backend boot generates and persists the key.
        String first = MatouBackendRunner.loadOrCreateIdentityKey(backing);
        assertNotNull(first);
        assertEquals("key generated on first launch", 1, backing.writes);

        // The next boot (app relaunch, or a headless push wake after a
        // stop/re-start) reads the identical key back, no new write.
        String second = MatouBackendRunner.loadOrCreateIdentityKey(backing);
        assertEquals("key stable across backend boots", first, second);
        assertEquals("no re-generation on later launches", 1, backing.writes);
    }

    @Test
    public void generatedKeyIs32BytesOfHex() {
        MapBacking backing = new MapBacking();
        String key = MatouBackendRunner.loadOrCreateIdentityKey(backing);
        assertEquals("32 bytes → 64 hex chars", 64, key.length());
        assertTrue("hex only", key.matches("[0-9a-f]+"));
        assertEquals("persisted verbatim", key, backing.store.get(MatouBackendRunner.IDENTITY_KEY_NAME));
    }

    @Test
    public void distinctInstallsGetDistinctKeys() {
        String a = MatouBackendRunner.loadOrCreateIdentityKey(new MapBacking());
        String b = MatouBackendRunner.loadOrCreateIdentityKey(new MapBacking());
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
        };
        try {
            MatouBackendRunner.loadOrCreateIdentityKey(failing);
            fail("expected the persistence failure to propagate");
        } catch (IllegalStateException e) {
            assertEquals("disk full", e.getMessage());
        }
    }

    @Test
    public void emptyStoredValueIsTreatedAsAbsent() {
        MapBacking backing = new MapBacking();
        backing.store.put(MatouBackendRunner.IDENTITY_KEY_NAME, "");
        String key = MatouBackendRunner.loadOrCreateIdentityKey(backing);
        assertEquals(64, key.length());
        assertEquals("empty value replaced by a real key", 1, backing.writes);
    }
}
