---------------------------- MODULE Permissions ----------------------------
(***************************************************************************)
(* 権限まわりの設計を、状態機械として書いたもの。                          *)
(*                                                                         *)
(* 守りたいのは 1 つだけ。                                                 *)
(*                                                                         *)
(*   **どのプロジェクトにも、実在するアカウントが所有者として                *)
(*     必ず 1 人以上いる。**                                               *)
(*                                                                         *)
(* これが破れると、そのプロジェクトは「誰も権限を配り直せず、誰も消せない」  *)
(* 状態になる。データは残るのに、手の出しようが無くなる。                   *)
(*                                                                         *)
(* 単体テストは「この操作でこうなる」を 1 本ずつ確かめる。ところがこの       *)
(* 不変条件は **操作の順序** で破れる。所有権がグループ経由になっていて、    *)
(* そのグループからメンバーが抜ける、といった筋は、誰かが思いつかないと      *)
(* テストにならない。TLC は到達しうる状態を全部たどるので、思いつく必要が    *)
(* ない。                                                                  *)
(*                                                                         *)
(* 対応する実装は crates/api/src/service.rs と permission.rs。              *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals

CONSTANTS
    Users,          \* アカウント
    UserGroups,     \* アカウントのまとまり (チーム)
    Projects,       \* プロジェクト
    ProjectGroups   \* プロジェクトの入れ物

\* 権限を配る相手は、アカウントかアカウントのグループ。
UserPrincipal(u)  == [kind |-> "user",  id |-> u]
GroupPrincipal(g) == [kind |-> "group", id |-> g]
Principals == {UserPrincipal(u) : u \in Users} \cup {GroupPrincipal(g) : g \in UserGroups}

\* 役割。強い順。所有者の有無だけが不変条件に効くので、区別はここまでで足りる。
Roles == {"viewer", "editor", "owner"}

\* 「どの入れ物にも入っていない」を表す印。TLC が数え上げられるよう、
\* 無制限の CHOOSE ではなく決め打ちの文字列にしてある。
NoGroup == "noGroup"

VARIABLES
    users,          \* 実在するアカウント
    ugroups,        \* 実在するアカウントのグループ
    members,        \* [UserGroups -> SUBSET Users] グループの構成員
    projects,       \* 実在するプロジェクト
    pgroups,        \* 実在するプロジェクトのグループ
    parent,         \* [Projects -> ProjectGroups \cup {NoGroup}] どの入れ物に居るか
    access,         \* [Projects -> [Principals -> Roles \cup {"none"}]]
    gaccess         \* [ProjectGroups -> [Principals -> Roles \cup {"none"}]]

vars == <<users, ugroups, members, projects, pgroups, parent, access, gaccess>>

-----------------------------------------------------------------------------
(***************************************************************************)
(* 実効的な所有者                                                          *)
(*                                                                         *)
(* 実装 (Service::owner_users) と同じ数え方をする。                        *)
(*                                                                         *)
(*  - プロジェクト自身への付与と、入れ物への付与の**両方**を見る            *)
(*  - グループ経由の所有者は、そのグループの構成員に展開する               *)
(*  - **実在しないアカウントは数えない。** 空のグループに owner を付けても  *)
(*    所有者がいることにはならない                                         *)
(***************************************************************************)
GrantsOf(p) ==
    IF parent[p] = NoGroup
      THEN {q \in Principals : access[p][q] = "owner"}
      ELSE {q \in Principals : access[p][q] = "owner" \/ gaccess[parent[p]][q] = "owner"}

OwnerUsers(p) ==
    LET direct == {u \in users : UserPrincipal(u) \in GrantsOf(p)}
        viaGroup == {u \in users :
                        \E g \in ugroups : GroupPrincipal(g) \in GrantsOf(p) /\ u \in members[g]}
    IN direct \cup viaGroup

\* ---- これが守りたいこと -------------------------------------------------
NoProjectLosesItsLastOwner ==
    \A p \in projects : OwnerUsers(p) # {}

-----------------------------------------------------------------------------
(***************************************************************************)
(* 状態を変える操作。**実装と同じ場所に同じ番人を置く。**                   *)
(*                                                                         *)
(* 番人を書き写し忘れると TLC がそこを突く。それがこの仕様の役目。          *)
(***************************************************************************)

Empty == [q \in Principals |-> "none"]

\* プロジェクトを作る。作った人が所有者になる (Service::create_project)。
CreateProject(p, u) ==
    /\ p \notin projects
    /\ u \in users
    /\ projects' = projects \cup {p}
    /\ access' = [access EXCEPT ![p] = [Empty EXCEPT ![UserPrincipal(u)] = "owner"]]
    /\ parent' = [parent EXCEPT ![p] = NoGroup]
    /\ UNCHANGED <<users, ugroups, members, pgroups, gaccess>>

DeleteProject(p) ==
    /\ p \in projects
    /\ projects' = projects \ {p}
    /\ UNCHANGED <<users, ugroups, members, pgroups, parent, access, gaccess>>

\* 権限を配る・外す (Service::set_access)。
\* 番人: 配り終えたあとに実在の所有者が 1 人以上いること。
SetAccess(p, q, r) ==
    /\ p \in projects
    /\ LET next == [access EXCEPT ![p][q] = r]
           ownersAfter ==
             LET g == IF parent[p] = NoGroup
                        THEN {x \in Principals : next[p][x] = "owner"}
                        ELSE {x \in Principals :
                                 next[p][x] = "owner" \/ gaccess[parent[p]][x] = "owner"}
             IN {u \in users : UserPrincipal(u) \in g}
                  \cup {u \in users :
                          \E gg \in ugroups : GroupPrincipal(gg) \in g /\ u \in members[gg]}
       IN /\ ownersAfter # {}
          /\ access' = next
    /\ UNCHANGED <<users, ugroups, members, projects, pgroups, parent, gaccess>>

\* 入れ物に権限を配る (Service::set_group_access)。
\* 番人: 入れ物自身と、そこに入っているプロジェクトの両方を見る。
SetGroupAccess(pg, q, r) ==
    /\ pg \in pgroups
    /\ LET next == [gaccess EXCEPT ![pg][q] = r]
           ownersOf(p) ==
             LET g == {x \in Principals : access[p][x] = "owner" \/ next[pg][x] = "owner"}
             IN {u \in users : UserPrincipal(u) \in g}
                  \cup {u \in users :
                          \E gg \in ugroups : GroupPrincipal(gg) \in g /\ u \in members[gg]}
       IN /\ \A p \in projects : parent[p] = pg => ownersOf(p) # {}
          /\ gaccess' = next
    /\ UNCHANGED <<users, ugroups, members, projects, pgroups, parent, access>>

\* プロジェクトを入れ物に入れる・出す (Service::update_project の group_id)。
\* 番人: 出したあとも所有者が残ること。
SetParent(p, pg) ==
    /\ p \in projects
    /\ pg \in (pgroups \cup {NoGroup})
    /\ LET g == IF pg = NoGroup
                  THEN {x \in Principals : access[p][x] = "owner"}
                  ELSE {x \in Principals : access[p][x] = "owner" \/ gaccess[pg][x] = "owner"}
           ownersAfter ==
             {u \in users : UserPrincipal(u) \in g}
               \cup {u \in users : \E gg \in ugroups : GroupPrincipal(gg) \in g /\ u \in members[gg]}
       IN /\ ownersAfter # {}
          /\ parent' = [parent EXCEPT ![p] = pg]
    /\ UNCHANGED <<users, ugroups, members, projects, pgroups, access, gaccess>>

\* アカウントを消す (Service::delete_user)。
DeleteUser(u) ==
    /\ u \in users
    /\ LET remaining == users \ {u}
           ownersOf(p) ==
             LET g == GrantsOf(p)
             IN {x \in remaining : UserPrincipal(x) \in g}
                  \cup {x \in remaining :
                          \E gg \in ugroups : GroupPrincipal(gg) \in g /\ x \in members[gg]}
       IN /\ \A p \in projects : ownersOf(p) # {}
          /\ users' = remaining
    \* 消えたアカウントはグループからも外れる。
    /\ members' = [g \in UserGroups |-> members[g] \ {u}]
    /\ UNCHANGED <<ugroups, projects, pgroups, parent, access, gaccess>>

CreateUser(u) ==
    /\ u \notin users
    /\ users' = users \cup {u}
    /\ UNCHANGED <<ugroups, members, projects, pgroups, parent, access, gaccess>>

CreateUserGroup(g) ==
    /\ g \notin ugroups
    /\ ugroups' = ugroups \cup {g}
    /\ members' = [members EXCEPT ![g] = {}]
    /\ UNCHANGED <<users, projects, pgroups, parent, access, gaccess>>

\* アカウントのグループを消す (Service::delete_user_group)。
DeleteUserGroup(g) ==
    /\ g \in ugroups
    /\ LET rest == ugroups \ {g}
           ownersOf(p) ==
             LET gr == GrantsOf(p)
             IN {u \in users : UserPrincipal(u) \in gr}
                  \cup {u \in users :
                          \E gg \in rest : GroupPrincipal(gg) \in gr /\ u \in members[gg]}
       IN /\ \A p \in projects : ownersOf(p) # {}
          /\ ugroups' = rest
    /\ UNCHANGED <<users, members, projects, pgroups, parent, access, gaccess>>

\* グループの出入り (Service::set_group_member)。
AddGroupMember(g, u) ==
    /\ g \in ugroups
    /\ u \in users
    /\ members' = [members EXCEPT ![g] = @ \cup {u}]
    /\ UNCHANGED <<users, ugroups, projects, pgroups, parent, access, gaccess>>

\* 番人: 抜けたあとも、どのプロジェクトにも所有者が残ること。
RemoveGroupMember(g, u) ==
    /\ g \in ugroups
    /\ u \in members[g]
    /\ LET next == [members EXCEPT ![g] = @ \ {u}]
           ownersOf(p) ==
             LET gr == GrantsOf(p)
             IN {x \in users : UserPrincipal(x) \in gr}
                  \cup {x \in users :
                          \E gg \in ugroups : GroupPrincipal(gg) \in gr /\ x \in next[gg]}
       IN /\ \A p \in projects : ownersOf(p) # {}
          /\ members' = next
    /\ UNCHANGED <<users, ugroups, projects, pgroups, parent, access, gaccess>>

CreateProjectGroup(pg) ==
    /\ pg \notin pgroups
    /\ pgroups' = pgroups \cup {pg}
    /\ gaccess' = [gaccess EXCEPT ![pg] = Empty]
    /\ UNCHANGED <<users, ugroups, members, projects, parent, access>>

\* プロジェクトの入れ物を消す (Service::delete_project_group)。
\* 中のプロジェクトは残り、所属だけ外れる。
DeleteProjectGroup(pg) ==
    /\ pg \in pgroups
    /\ LET ownersWithout(p) ==
             LET g == {x \in Principals : access[p][x] = "owner"}
             IN {u \in users : UserPrincipal(u) \in g}
                  \cup {u \in users :
                          \E gg \in ugroups : GroupPrincipal(gg) \in g /\ u \in members[gg]}
       IN /\ \A p \in projects : parent[p] = pg => ownersWithout(p) # {}
          /\ pgroups' = pgroups \ {pg}
    /\ parent' = [p \in Projects |-> IF parent[p] = pg THEN NoGroup ELSE parent[p]]
    /\ UNCHANGED <<users, ugroups, members, projects, access, gaccess>>

-----------------------------------------------------------------------------
Init ==
    /\ users = Users            \* アカウントは最初から全員いる
    /\ ugroups = {}
    /\ members = [g \in UserGroups |-> {}]
    /\ projects = {}
    /\ pgroups = {}
    /\ parent = [p \in Projects |-> NoGroup]
    /\ access = [p \in Projects |-> Empty]
    /\ gaccess = [pg \in ProjectGroups |-> Empty]

Next ==
    \/ \E p \in Projects, u \in Users : CreateProject(p, u)
    \/ \E p \in Projects : DeleteProject(p)
    \/ \E p \in Projects, q \in Principals, r \in (Roles \cup {"none"}) : SetAccess(p, q, r)
    \/ \E pg \in ProjectGroups, q \in Principals, r \in (Roles \cup {"none"}) :
           SetGroupAccess(pg, q, r)
    \/ \E p \in Projects, pg \in (ProjectGroups \cup {NoGroup}) : SetParent(p, pg)
    \/ \E u \in Users : CreateUser(u)
    \/ \E u \in Users : DeleteUser(u)
    \/ \E g \in UserGroups : CreateUserGroup(g)
    \/ \E g \in UserGroups : DeleteUserGroup(g)
    \/ \E g \in UserGroups, u \in Users : AddGroupMember(g, u)
    \/ \E g \in UserGroups, u \in Users : RemoveGroupMember(g, u)
    \/ \E pg \in ProjectGroups : CreateProjectGroup(pg)
    \/ \E pg \in ProjectGroups : DeleteProjectGroup(pg)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* 型の健全性。状態が想定した形から外れていないことの見張り。
TypeOK ==
    /\ users \subseteq Users
    /\ ugroups \subseteq UserGroups
    /\ members \in [UserGroups -> SUBSET Users]
    /\ projects \subseteq Projects
    /\ pgroups \subseteq ProjectGroups
    /\ parent \in [Projects -> ProjectGroups \cup {NoGroup}]
    /\ access \in [Projects -> [Principals -> Roles \cup {"none"}]]
    /\ gaccess \in [ProjectGroups -> [Principals -> Roles \cup {"none"}]]

\* グループの構成員は実在するアカウントだけ (消えた人が残らない)。
MembersAreRealUsers ==
    \A g \in ugroups : members[g] \subseteq users

=============================================================================
