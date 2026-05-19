use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Local, Utc};
use feishu_client::{FeishuClient, FeishuError};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::db::{self, Message};

#[derive(Clone, Serialize)]
struct SyncStatusChanged {
    id: String,
    status: String,
}

pub async fn sync_message(
    feishu_client: Arc<FeishuClient>,
    db: Arc<Mutex<Connection>>,
    doc_id: String,
    message: Message,
    app_handle: AppHandle,
) {
    let content = format_message_content(&message);
    let mut rate_limited_once = false;

    loop {
        match feishu_client
            .append_text(&doc_id, &content, &message.id)
            .await
        {
            Ok(()) => {
                let synced_at = Utc::now().to_rfc3339();
                if let Ok(conn) = db.lock() {
                    let _ = db::update_sync_status(&conn, &message.id, "synced", Some(&synced_at));
                }
                emit_status(&app_handle, &message.id, "synced");
                return;
            }
            Err(FeishuError::RateLimited) if !rate_limited_once => {
                rate_limited_once = true;
                sleep(Duration::from_millis(350)).await;
            }
            Err(FeishuError::NetworkError(_)) => {
                let retry_count = if let Ok(conn) = db.lock() {
                    db::increment_retry(&conn, &message.id).unwrap_or(message.retry_count + 1)
                } else {
                    message.retry_count + 1
                };

                if retry_count >= 5 {
                    if let Ok(conn) = db.lock() {
                        let _ = db::update_sync_status(&conn, &message.id, "failed", None);
                    }
                    emit_status(&app_handle, &message.id, "failed");
                }
                return;
            }
            Err(FeishuError::RateLimited)
            | Err(FeishuError::AuthError(_))
            | Err(FeishuError::ApiError { .. }) => {
                if let Ok(conn) = db.lock() {
                    let _ = db::update_sync_status(&conn, &message.id, "failed", None);
                }
                emit_status(&app_handle, &message.id, "failed");
                return;
            }
        }
    }
}

pub async fn sync_all_queued(
    feishu_client: Arc<FeishuClient>,
    db: Arc<Mutex<Connection>>,
    doc_id: String,
    app_handle: AppHandle,
) {
    let messages = if let Ok(conn) = db.lock() {
        db::get_queued_messages(&conn).unwrap_or_default()
    } else {
        Vec::new()
    };

    for message in messages {
        sync_message(
            Arc::clone(&feishu_client),
            Arc::clone(&db),
            doc_id.clone(),
            message,
            app_handle.clone(),
        )
        .await;
        sleep(Duration::from_millis(350)).await;
    }
}

fn format_message_content(message: &Message) -> String {
    let time = DateTime::parse_from_rfc3339(&message.created_at)
        .map(|dt| dt.with_timezone(&Local).format("%H:%M:%S").to_string())
        .unwrap_or_else(|_| message.created_at.clone());
    format!("[{}] {}", time, message.text)
}

fn emit_status(app_handle: &AppHandle, id: &str, status: &str) {
    let _ = app_handle.emit(
        "sync_status_changed",
        SyncStatusChanged {
            id: id.to_string(),
            status: status.to_string(),
        },
    );
}
