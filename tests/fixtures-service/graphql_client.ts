// Fixture: GraphQL client calls — Apollo client + React hooks + gql tagged
// template literals.

declare const client: any;
declare const apolloClient: any;
declare function gql(strings: TemplateStringsArray): any;
declare function useQuery(doc: any, opts?: any): unknown;
declare function useMutation(doc: any, opts?: any): unknown;

// Inline gql tag — operation field = "user", op name = "GetUser".
const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

const CREATE_USER = gql`
  mutation CreateUser($name: String!) {
    createUser(name: $name) {
      id
    }
  }
`;

const ON_USER_CREATED = gql`
  subscription OnUserCreated {
    onUserCreated {
      id
    }
  }
`;

export async function fetchUser(id: string): Promise<unknown> {
  // operation lifted from GET_USER document — should resolve to field "user"
  return client.query({ query: GET_USER, variables: { id } });
}

export async function createUserViaApollo(name: string): Promise<unknown> {
  return apolloClient.mutate({ mutation: CREATE_USER, variables: { name } });
}

export function useUserHook(id: string): unknown {
  // useQuery hook with inline gql tag — operation = field "users"
  return useQuery(gql`
    query ListAllUsers {
      users {
        id
        name
      }
    }
  `);
}

export function useCreateUserHook(): unknown {
  return useMutation(CREATE_USER);
}

export function useOnUserCreated(): unknown {
  return useQuery(ON_USER_CREATED);
}

// Regression guard: a plain IIFE is a call_expression whose body contains a
// `{`, but it is NOT a gql document. The gql-doc detector must not emit a
// sentinel service_call for it (see parseGqlOperation header/`{` gate).
const counter = (() => {
  let n = 0;
  return { inc: () => ++n, dec: () => --n };
})();

export { counter };
