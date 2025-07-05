# Stage 1: Build the application
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Copy the project file and restore dependencies
COPY *.csproj .
RUN dotnet restore

# Copy the rest of the source code
COPY . .

# Publish the application
RUN dotnet publish -c Release -o /app/publish

# Stage 2: Create the final runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app

# Install ffmpeg in the final image
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the published output from the build stage
COPY --from=build /app/publish/. .

# The entrypoint is now the standard Web API DLL
ENTRYPOINT ["dotnet", "JreVideoProcessor.dll"]