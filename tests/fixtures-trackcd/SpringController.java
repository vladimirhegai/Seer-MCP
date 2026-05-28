// Spring Boot mapping annotations + System.getenv.
package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class SpringController {

    @GetMapping("/users")
    public String listUsers() {
        String db = System.getenv("DATABASE_URL");
        if (db == null) {
            return "no-db";
        } else if (db.startsWith("postgres")) {
            return "pg";
        } else {
            return "other";
        }
    }

    @PostMapping("/users")
    public String createUser(@RequestBody String body) {
        return "created";
    }

    @DeleteMapping("/users/{id}")
    public String deleteUser(@PathVariable String id) {
        return "deleted";
    }

    @RequestMapping(value = "/items", method = RequestMethod.GET)
    public String listItems() {
        return "items";
    }
}
