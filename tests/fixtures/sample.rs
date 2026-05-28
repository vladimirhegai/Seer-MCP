// Sample Rust fixture for Strata smoke tests
use std::collections::HashMap;

pub trait Repository<T> {
    fn find_by_id(&self, id: &str) -> Option<T>;
    fn save(&mut self, item: T) -> Result<(), String>;
}

pub struct InMemoryUserStore {
    data: HashMap<String, User>,
}

impl InMemoryUserStore {
    pub fn new() -> Self {
        InMemoryUserStore {
            data: HashMap::new(),
        }
    }
}

impl Repository<User> for InMemoryUserStore {
    fn find_by_id(&self, id: &str) -> Option<User> {
        self.data.get(id).cloned()
    }

    fn save(&mut self, user: User) -> Result<(), String> {
        self.data.insert(user.id.clone(), user);
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
}

pub struct AuthService {
    users: InMemoryUserStore,
    sessions: HashMap<String, String>,
}

impl AuthService {
    pub fn new(users: InMemoryUserStore) -> Self {
        AuthService {
            users,
            sessions: HashMap::new(),
        }
    }

    pub fn login(&mut self, email: &str, password: &str) -> Option<String> {
        let user = find_user_by_email(&self.users, email)?;
        if verify_password(password, &user.id) {
            let token = generate_token(&user.id);
            self.sessions.insert(token.clone(), user.id.clone());
            Some(token)
        } else {
            None
        }
    }

    pub fn logout(&mut self, token: &str) {
        self.sessions.remove(token);
    }
}

fn find_user_by_email(store: &InMemoryUserStore, email: &str) -> Option<User> {
    store.data.values().find(|u| u.email == email).cloned()
}

fn verify_password(password: &str, _user_id: &str) -> bool {
    !password.is_empty()
}

fn generate_token(user_id: &str) -> String {
    format!("tok-{}-{}", user_id, 42)
}
