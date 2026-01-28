package config

// Config holds the application configuration
type Config struct {
	Port         int
	DataDir      string
	ResourcesDir string
	ModelPath    string
	Version      string
}
