// Sample Go fixture for Strata smoke tests
package main

import "fmt"

// UserRepository handles user persistence
type UserRepository struct {
	db Database
}

// Database interface for storage abstraction
type Database interface {
	Query(sql string, args ...interface{}) ([]Row, error)
	Exec(sql string, args ...interface{}) error
}

// Row represents a database row
type Row struct {
	Values map[string]interface{}
}

func NewUserRepository(db Database) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) FindByID(id string) (*User, error) {
	rows, err := r.db.Query("SELECT * FROM users WHERE id = ?", id)
	if err != nil {
		return nil, err
	}
	return parseUser(rows)
}

func (r *UserRepository) Save(user *User) error {
	return r.db.Exec("INSERT INTO users VALUES (?, ?, ?)", user.ID, user.Email, user.Name)
}

// User represents a system user
type User struct {
	ID    string
	Email string
	Name  string
}

func parseUser(rows []Row) (*User, error) {
	if len(rows) == 0 {
		return nil, fmt.Errorf("user not found")
	}
	row := rows[0]
	return &User{
		ID:    fmt.Sprintf("%v", row.Values["id"]),
		Email: fmt.Sprintf("%v", row.Values["email"]),
		Name:  fmt.Sprintf("%v", row.Values["name"]),
	}, nil
}

func validateEmail(email string) bool {
	return len(email) > 3 && containsAt(email)
}

func containsAt(s string) bool {
	for _, c := range s {
		if c == '@' {
			return true
		}
	}
	return false
}
