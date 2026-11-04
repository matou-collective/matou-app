/**
 * Org-setup pilot area (#783). `en` is authoritative.
 *
 * `{brand}` is the kit brand name, passed in by the component. Progress keys
 * mirror the step keys the `useOrgSetup` composable emits (key + params, not
 * finished English) so the live status line reads in the chosen language.
 */
export default {
  logoAlt: '{brand} Logo',
  title: 'Set up {brand}',
  firstAdminNotice:
    "You're the first admin. Create your admin profile to bring {brand} online.",
  adminNameLabel: 'Admin Display Name',
  adminNamePlaceholder: 'e.g., John Smith',
  adminEmailLabel: 'Admin Email',
  adminEmailPlaceholder: "admin{'@'}example.com",
  adminAvatarLabel: 'Admin Avatar',
  avatarPreviewAlt: 'Avatar preview',
  changeAvatar: 'Change',
  uploadAvatar: 'Upload',
  removeAvatar: 'Remove',
  errorTitle: 'Setup Failed',
  launchApp: 'Launch App',
  settingUp: 'Setting up your organization...',
  steps: {
    connecting: 'Connect to KERIA',
    admin: 'Create admin identity',
    organization: 'Create organization',
    registry: 'Create credential registry',
    credential: 'Issue admin credential',
    space: 'Create spaces',
    saving: 'Save configuration',
  },
  progress: {
    generating: 'Generating admin credentials...',
    connecting: 'Connecting to KERIA...',
    admin: 'Creating admin identity...',
    organization: 'Creating organization identity...',
    registry: 'Creating credential registry...',
    schema: 'Loading credential schema...',
    credential: 'Issuing admin credential...',
    oobi: 'Generating organization OOBI...',
    backend: 'Configuring backend identity...',
    space: 'Creating community space...',
    saving: 'Saving configuration...',
    complete: 'Setup complete!',
  },
};
