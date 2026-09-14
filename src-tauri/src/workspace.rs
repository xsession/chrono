use std::fs;
use tauri::{AppHandle, Manager};
use crate::error::{AppError, AppResult};
use crate::models::Workspace;
fn path(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let directory = app.path().app_config_dir().map_err(|error| AppError::Invalid(error.to_string()))?;
    fs::create_dir_all(&directory)?;
    Ok(directory.join("workspaces.json"))
}
pub fn load(app: &AppHandle) -> AppResult<Vec<Workspace>> {
    let path = path(app)?;
    if !path.exists() { return Ok(Vec::new()); }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub fn save(app: &AppHandle, workspaces: &[Workspace]) -> AppResult<()> {
    let path = path(app)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(workspaces)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}
