# Stage 1: Build the application using an Alpine-based SDK
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src

# Install ffmpeg using Alpine's package manager 'apk'
RUN apk add --no-cache ffmpeg libgdiplus

# Copy the project file first to leverage Docker's layer caching
COPY *.csproj .
# Restore dependencies
RUN dotnet restore

# Copy the rest of the application's source code
COPY . .

# Publish the application for the Alpine runtime (linux-musl-x64)
# The output will be in the '/app/publish' directory as requested
RUN dotnet publish -c Release -o /app/publish --self-contained --runtime linux-musl-x64

# Stage 2: Create the final runtime image using the Alpine ASP.NET image
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
WORKDIR /app

# Install ffmpeg in the final image using apk
RUN apk add --no-cache ffmpeg libgdiplus

# Copy the published files from the build stage
# The source path is /app/publish, matching the output of the publish command
COPY --from=build /app/publish .

# --- DEBUGGING STEP (Optional) ---
# This will correctly list the contents of the /app directory in your build logs
RUN echo "Final contents of /app directory:" && ls -la

# Set the entrypoint to run the .NET application
ENTRYPOINT ["dotnet", "JreVideoProcessor.dll"]