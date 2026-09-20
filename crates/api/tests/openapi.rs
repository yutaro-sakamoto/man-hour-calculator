//! OpenAPI の記述と、コードが持つルート表が食い違っていないかを確かめる。
//!
//! 仕様書は放っておくと実装から離れていく。`Request::route` が唯一の正で、
//! この文書はそれを人間向けに書き下したもの、という関係をテストで固定する。

use mhc_api::model::{Document, ProjectId, ProjectRole, SystemRole, UserId};
use mhc_api::protocol::Request;

const SPEC: &str = include_str!("../../../docs/openapi.yaml");

/// コードが持つすべての操作。
fn every_request() -> Vec<Request> {
    vec![
        Request::Me,
        Request::ListUsers,
        Request::CreateUser {
            id: UserId::new("x"),
            name: "x".into(),
            email: None,
            system_role: SystemRole::Member,
        },
        Request::UpdateUser {
            id: UserId::new("x"),
            name: None,
            email: None,
            clear_email: false,
            system_role: None,
        },
        Request::DeleteUser {
            id: UserId::new("x"),
        },
        Request::ListProjects,
        Request::CreateProject {
            id: ProjectId::new("p"),
            name: "p".into(),
            document: Document::default(),
        },
        Request::GetProject {
            id: ProjectId::new("p"),
        },
        Request::SaveDocument {
            id: ProjectId::new("p"),
            document: Document::default(),
        },
        Request::RenameProject {
            id: ProjectId::new("p"),
            name: "q".into(),
        },
        Request::DeleteProject {
            id: ProjectId::new("p"),
        },
        Request::DuplicateProject {
            id: ProjectId::new("p"),
            new_id: ProjectId::new("q"),
            name: "q".into(),
        },
        Request::ListAccess {
            id: ProjectId::new("p"),
        },
        Request::SetAccess {
            id: ProjectId::new("p"),
            user_id: UserId::new("x"),
            role: ProjectRole::Editor,
        },
        Request::RemoveAccess {
            id: ProjectId::new("p"),
            user_id: UserId::new("x"),
        },
    ]
}

/// `paths:` の下に現れるパスを、書かれている順に拾う。
fn documented_paths() -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in SPEC.lines() {
        if line.starts_with("paths:") {
            inside = true;
            continue;
        }
        if inside && !line.starts_with(' ') && !line.trim().is_empty() {
            break; // 次のトップレベルの項目に入った
        }
        if inside {
            let trimmed = line.trim_end();
            if let Some(path) = trimmed.strip_prefix("  /") {
                if let Some(name) = path.strip_suffix(':') {
                    out.push(format!("/{name}"));
                }
            }
        }
    }
    out
}

#[test]
fn every_operation_is_documented() {
    let documented = documented_paths();
    assert!(!documented.is_empty(), "paths を読み取れていない");

    for request in every_request() {
        let (method, path) = request.route();
        assert!(
            documented.iter().any(|item| item == path),
            "{path} が openapi.yaml に無い ({request:?})"
        );
        // メソッドがそのパスの下に書かれていること。
        // 区切りで消えた改行を戻してから探す (先頭行も拾えるように)。
        let block = SPEC
            .split(&format!("\n  {path}:\n"))
            .nth(1)
            .map(|rest| format!("\n{}", rest.split("\n  /").next().unwrap_or_default()))
            .unwrap_or_default();
        let verb = format!("\n    {}:", method.to_lowercase());
        assert!(
            block.contains(&verb),
            "{method} {path} が openapi.yaml に無い"
        );
    }
}

#[test]
fn nothing_extra_is_documented() {
    let known: Vec<&'static str> = every_request()
        .iter()
        .map(|request| request.route().1)
        .collect();
    for path in documented_paths() {
        assert!(
            known.contains(&path.as_str()),
            "{path} は openapi.yaml にあるが、コードに対応する操作が無い"
        );
    }
}

#[test]
fn the_version_matches() {
    assert!(
        SPEC.contains(&format!("version: \"{}\"", mhc_api::API_VERSION)),
        "openapi.yaml の version が API_VERSION と違う"
    );
}
