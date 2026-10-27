mod persistence;
mod remote;
mod service;
mod types;

pub use remote::{CommunityThemeRemote, CommunityThemeRemoteFuture};
pub use service::CommunityThemeService;
pub use types::{
    CommunityThemeAuthor, CommunityThemeCatalog, CommunityThemeConfigureInput,
    CommunityThemeInstallMetadata, CommunityThemeManifest, CommunityThemeProjection,
    CommunityThemeStatsById, CommunityThemeStatsEntry, CommunityThemeUpdate,
};

#[cfg(test)]
use vrcx_0_contracts::community_theme_protocol as protocol;

#[cfg(test)]
mod tests;
