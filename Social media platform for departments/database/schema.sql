CREATE DATABASE IF NOT EXISTS kare_cse_social;
USE kare_cse_social;

CREATE TABLE roles (
    role_id TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

INSERT IGNORE INTO roles (role_name) VALUES
    ('Faculty'),
    ('Student Coordinator'),
    ('Administrator'),
    ('Placement Staff'),
    ('General User');

CREATE TABLE departments (
    department_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_code VARCHAR(20) NOT NULL UNIQUE,
    department_name VARCHAR(150) NOT NULL,
    status ENUM('active', 'inactive', 'onboarding') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO departments (department_code, department_name) VALUES
    ('CSE', 'Computer Science and Engineering'),
    ('IT', 'Information Technology'),
    ('ECE', 'Electronics and Communication Engineering'),
    ('MECH', 'Mechanical Engineering');

CREATE TABLE users (
    user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id INT UNSIGNED NULL,
    role_id TINYINT UNSIGNED NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    email VARCHAR(180) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    initials CHAR(2) NULL,
    status ENUM('active', 'inactive', 'pending') NOT NULL DEFAULT 'active',
    last_login_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(department_id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id),
    UNIQUE KEY uq_users_role_email (role_id, email),
    INDEX idx_users_department (department_id),
    INDEX idx_users_role (role_id)
);

CREATE TABLE event_templates (
    template_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id INT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL,
    template_name VARCHAR(120) NOT NULL,
    template_type ENUM('workshop', 'seminar', 'hackathon', 'placement', 'event', 'achievement', 'other') NOT NULL,
    description VARCHAR(255) NULL,
    preview_image_url VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_templates_department FOREIGN KEY (department_id) REFERENCES departments(department_id),
    CONSTRAINT fk_templates_creator FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_templates_department (department_id)
);

CREATE TABLE posts (
    post_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id INT UNSIGNED NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    template_id INT UNSIGNED NULL,
    title VARCHAR(200) NOT NULL,
    post_type ENUM('workshop', 'seminar', 'hackathon', 'placement', 'event', 'achievement', 'other') NOT NULL,
    description TEXT NULL,
    caption TEXT NULL,
    poster_url LONGTEXT NULL,
    event_date DATE NULL,
    event_time TIME NULL,
    venue VARCHAR(180) NULL,
    status ENUM('draft', 'pending', 'approved', 'rejected', 'scheduled', 'published', 'cancelled') NOT NULL DEFAULT 'draft',
    rejection_reason TEXT NULL,
    submitted_at DATETIME NULL,
    approved_at DATETIME NULL,
    published_at DATETIME NULL,
    ai_embedding JSON NULL,
    ai_embedding_model VARCHAR(100) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_posts_department FOREIGN KEY (department_id) REFERENCES departments(department_id),
    CONSTRAINT fk_posts_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
    CONSTRAINT fk_posts_template FOREIGN KEY (template_id) REFERENCES event_templates(template_id) ON DELETE SET NULL,
    INDEX idx_posts_status_date (status, event_date),
    INDEX idx_posts_department (department_id),
    INDEX idx_posts_creator (created_by)
);

CREATE TABLE post_likes (
    post_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, user_id),
    CONSTRAINT fk_post_likes_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT fk_post_likes_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_post_likes_user (user_id)
);

CREATE TABLE event_registrations (
    registration_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    registration_url VARCHAR(1000) NULL,
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    google_calendar_event_id VARCHAR(255) NULL,
    calendar_sync_status ENUM('not_connected', 'synced', 'failed') NOT NULL DEFAULT 'not_connected',
    calendar_sync_error TEXT NULL,
    CONSTRAINT fk_event_registrations_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT fk_event_registrations_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY uq_event_registration_user_post (post_id, user_id),
    INDEX idx_event_registrations_user (user_id)
);

CREATE TABLE google_calendar_connections (
    connection_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    google_subject VARCHAR(255) NOT NULL,
    google_email VARCHAR(255) NULL,
    access_token_encrypted TEXT NULL,
    refresh_token_encrypted TEXT NULL,
    token_expires_at DATETIME NULL,
    scopes TEXT NULL,
    connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_google_calendar_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY uq_google_calendar_user (user_id),
    UNIQUE KEY uq_google_calendar_subject (google_subject)
);

ALTER TABLE posts MODIFY poster_url LONGTEXT NULL;

CREATE TABLE post_approvals (
    approval_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    reviewer_id BIGINT UNSIGNED NOT NULL,
    decision ENUM('pending', 'approved', 'rejected') NOT NULL,
    comments TEXT NULL,
    reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_approvals_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT fk_approvals_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(user_id),
    INDEX idx_approvals_post (post_id),
    INDEX idx_approvals_decision (decision)
);

CREATE TABLE calendar_events (
    calendar_event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id INT UNSIGNED NOT NULL,
    post_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    event_title VARCHAR(200) NOT NULL,
    event_date DATE NOT NULL,
    event_time TIME NULL,
    venue VARCHAR(180) NULL,
    status ENUM('scheduled', 'approved', 'pending', 'draft', 'cancelled') NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_calendar_department FOREIGN KEY (department_id) REFERENCES departments(department_id),
    CONSTRAINT fk_calendar_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE SET NULL,
    CONSTRAINT fk_calendar_creator FOREIGN KEY (created_by) REFERENCES users(user_id),
    UNIQUE KEY uq_calendar_post (post_id),
    INDEX idx_calendar_date (event_date),
    INDEX idx_calendar_status (status)
);

CREATE TABLE social_accounts (
    social_account_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id INT UNSIGNED NOT NULL,
    platform ENUM('instagram', 'linkedin', 'x', 'facebook') NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    access_token_encrypted TEXT NULL,
    token_expires_at DATETIME NULL,
    connection_status ENUM('connected', 'expired', 'disconnected') NOT NULL DEFAULT 'disconnected',
    connected_at DATETIME NULL,
    CONSTRAINT fk_social_department FOREIGN KEY (department_id) REFERENCES departments(department_id),
    UNIQUE KEY uq_social_department_platform (department_id, platform)
);

CREATE TABLE post_publications (
    publication_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    social_account_id BIGINT UNSIGNED NOT NULL,
    external_post_id VARCHAR(180) NULL,
    publication_status ENUM('queued', 'published', 'failed') NOT NULL DEFAULT 'queued',
    published_at DATETIME NULL,
    error_message TEXT NULL,
    CONSTRAINT fk_publications_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT fk_publications_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(social_account_id),
    UNIQUE KEY uq_post_account (post_id, social_account_id)
);

CREATE TABLE post_analytics (
    analytics_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    social_account_id BIGINT UNSIGNED NULL,
    recorded_on DATE NOT NULL,
    reach_count INT UNSIGNED NOT NULL DEFAULT 0,
    impressions_count INT UNSIGNED NOT NULL DEFAULT 0,
    likes_count INT UNSIGNED NOT NULL DEFAULT 0,
    comments_count INT UNSIGNED NOT NULL DEFAULT 0,
    shares_count INT UNSIGNED NOT NULL DEFAULT 0,
    clicks_count INT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT fk_analytics_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT fk_analytics_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(social_account_id) ON DELETE SET NULL,
    UNIQUE KEY uq_analytics_post_account_date (post_id, social_account_id, recorded_on)
);

CREATE TABLE notifications (
    notification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    post_id BIGINT UNSIGNED NULL,
    notification_type ENUM('approval', 'rejection', 'publication', 'system') NOT NULL,
    title VARCHAR(180) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_notifications_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE SET NULL,
    INDEX idx_notifications_user_read (user_id, is_read)
);

CREATE TABLE audit_logs (
    audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    action_name VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id BIGINT UNSIGNED NULL,
    details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_created (created_at)
);

