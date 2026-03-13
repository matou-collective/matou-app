package contributions

import "encoding/json"

// MockObjectStore implements ObjectStore for testing.
// It tracks object types so List can filter correctly, matching real any-sync behavior.
type MockObjectStore struct {
	objects map[string]map[string][]byte // spaceID -> objectID -> data
	types   map[string]map[string]string // spaceID -> objectID -> objectType
}

func NewMockStore() *MockObjectStore {
	return &MockObjectStore{
		objects: make(map[string]map[string][]byte),
		types:   make(map[string]map[string]string),
	}
}

func (m *MockObjectStore) Save(spaceID, objectID, objectType string, data interface{}) error {
	if m.objects[spaceID] == nil {
		m.objects[spaceID] = make(map[string][]byte)
		m.types[spaceID] = make(map[string]string)
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	m.objects[spaceID][objectID] = b
	m.types[spaceID][objectID] = objectType
	return nil
}

func (m *MockObjectStore) Get(spaceID, objectID string, dest interface{}) error {
	if m.objects[spaceID] == nil {
		return ErrNotFound
	}
	b, ok := m.objects[spaceID][objectID]
	if !ok {
		return ErrNotFound
	}
	return json.Unmarshal(b, dest)
}

func (m *MockObjectStore) List(spaceID, objectType string) ([]json.RawMessage, error) {
	var results []json.RawMessage
	if m.objects[spaceID] == nil {
		return results, nil
	}
	for id, b := range m.objects[spaceID] {
		if m.types[spaceID][id] == objectType {
			results = append(results, json.RawMessage(b))
		}
	}
	return results, nil
}

func (m *MockObjectStore) Delete(spaceID, objectID string) error {
	if m.objects[spaceID] != nil {
		delete(m.objects[spaceID], objectID)
		delete(m.types[spaceID], objectID)
	}
	return nil
}
