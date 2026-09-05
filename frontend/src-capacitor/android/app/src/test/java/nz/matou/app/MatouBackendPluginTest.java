package nz.matou.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * JVM unit test for the identity-encryption-key seam (#117). It exercises the
 * generate-once / read-back logic through an in-memory KeyBacking, so no Android
 * Keystore is needed — the on-device EncryptedSharedPreferences backing is a
 * thin adapter over the same interface.
 */
public class MatouBackendPluginTest {

    /** In-memory stand-in for the EncryptedSharedPreferences-backed store. */
    private static final class MapBacking implements MatouBackendPlugin.KeyBacking {
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

        // First plugin instance generates and persists the key.
        String first = MatouBackendPlugin.loadOrCreateIdentityKey(backing);
        assertNotNull(first);
        assertEquals("key generated on first launch", 1, backing.writes);

        // A second plugin instance reads the identical key back, no new write.
        String second = MatouBackendPlugin.loadOrCreateIdentityKey(backing);
        assertEquals("key stable across plugin instances", first, second);
        assertEquals("no re-generation on later launches", 1, backing.writes);
    }

    @Test
    public void generatedKeyIs32BytesOfHex() {
        MapBacking backing = new MapBacking();
        String key = MatouBackendPlugin.loadOrCreateIdentityKey(backing);
        assertEquals("32 bytes → 64 hex chars", 64, key.length());
        assertTrue("hex only", key.matches("[0-9a-f]+"));
    }

    @Test
    public void distinctInstallsGetDistinctKeys() {
        String a = MatouBackendPlugin.loadOrCreateIdentityKey(new MapBacking());
        String b = MatouBackendPlugin.loadOrCreateIdentityKey(new MapBacking());
        assertNotEquals("each install generates its own key", a, b);
    }
}
